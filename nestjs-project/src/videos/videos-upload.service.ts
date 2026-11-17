import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidUploadPartsException,
  UnsupportedMediaTypeException,
  UploadLimitExceededException,
  VideoAccessDeniedException,
  VideoInvalidStateException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import {
  type CompletedPartInput,
  S3StorageService,
} from '../storage/s3-storage.service';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generateShortCode } from './short-code.util';
import { VideosQueueService } from './videos-queue.service';
import {
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_MULTIPART_PARTS,
  MIME_TO_EXTENSION,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const MAX_SHORT_CODE_RETRIES = 5;

function isPgUniqueViolationOnShortCode(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const pgErr = err as { code?: string; detail?: string };
  return (
    pgErr.code === PG_UNIQUE_VIOLATION &&
    typeof pgErr.detail === 'string' &&
    pgErr.detail.includes('short_code')
  );
}

function isS3UploadPartsClientError(err: unknown): boolean {
  const s3Err = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const code = s3Err?.Code ?? s3Err?.name ?? '';
  return (
    s3Err?.$metadata?.httpStatusCode === 400 ||
    [
      'InvalidPart',
      'InvalidPartOrder',
      'EntityTooSmall',
      'MalformedXML',
      'NoSuchUpload',
    ].includes(code)
  );
}

export interface InitiateUploadResult {
  videoId: string;
  shortCode: string;
  status: VideoStatus;
  uploadId: string;
  storageKey: string;
  partSizeBytes: number;
  maxParts: number;
}

export interface SignUploadPartResult {
  partNumber: number;
  presignedUrl: string;
  expiresInSeconds: number;
}

export interface CompleteUploadResult {
  videoId: string;
  shortCode: string;
  status: VideoStatus;
  jobId: string;
}

@Injectable()
export class VideosUploadService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: S3StorageService,
    private readonly queueService: VideosQueueService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    if (!ALLOWED_VIDEO_MIME_TYPES.has(dto.mimeType)) {
      throw new UnsupportedMediaTypeException(dto.mimeType);
    }

    if (dto.sizeBytes > this.config.maxFileSizeBytes) {
      throw new UploadLimitExceededException(this.config.maxFileSizeBytes);
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const video = await this.createDraftVideoWithUniqueShortCode(
      channel.id,
      dto,
    );
    const ext = MIME_TO_EXTENSION[dto.mimeType] ?? 'mp4';
    const storageKey = `videos/${channel.id}/${video.id}/original.${ext}`;

    let uploadId: string;
    try {
      uploadId = await this.storageService.createMultipartUpload(
        storageKey,
        dto.mimeType,
      );
      video.storage_key = storageKey;
      video.upload_id = uploadId;
      await this.videoRepository.save(video);
    } catch (err) {
      await this.videoRepository.delete({ id: video.id });
      throw err;
    }

    return {
      videoId: video.id,
      shortCode: video.short_code,
      status: video.status,
      uploadId,
      storageKey,
      partSizeBytes: this.config.defaultPartSizeBytes,
      maxParts: MAX_MULTIPART_PARTS,
    };
  }

  async signUploadPart(
    userId: string,
    videoId: string,
    partNumber: number,
  ): Promise<SignUploadPartResult> {
    const video = await this.requireOwnedDraftVideo(userId, videoId);
    const presignedUrl = await this.storageService.getPresignedPartUrl(
      video.storage_key!,
      video.upload_id!,
      partNumber,
      this.config.presignedUrlExpiresInSeconds,
    );

    return {
      partNumber,
      presignedUrl,
      expiresInSeconds: this.config.presignedUrlExpiresInSeconds,
    };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    parts: CompletedPartInput[],
  ): Promise<CompleteUploadResult> {
    const video = await this.requireOwnedDraftVideo(userId, videoId);

    const uniquePartNumbers = new Set(parts.map((p) => p.partNumber));
    if (uniquePartNumbers.size !== parts.length) {
      throw new InvalidUploadPartsException(
        'Duplicate part numbers are not allowed',
      );
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key!,
        video.upload_id!,
        parts,
      );
    } catch (err) {
      if (isS3UploadPartsClientError(err)) {
        throw new InvalidUploadPartsException(
          'Storage rejected multipart upload completion parts',
        );
      }
      throw err;
    }

    const head = await this.storageService.headObject(video.storage_key!);
    if (head.contentLength > this.config.maxFileSizeBytes) {
      await this.storageService.deleteObject(video.storage_key!);
      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.FAILED,
          upload_id: null,
          processing_error: 'Uploaded object exceeded maximum allowed size',
        },
      );
      throw new UploadLimitExceededException(this.config.maxFileSizeBytes);
    }

    const updateResult = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.PROCESSING,
        upload_id: null,
        size_bytes: String(head.contentLength),
      },
    );

    if (updateResult.affected !== 1) {
      throw new VideoInvalidStateException(
        'Video upload was already completed or is no longer a draft',
      );
    }

    const jobId = await this.queueService.enqueueProcessVideo({
      videoId: video.id,
      channelId: video.channel_id,
      storageKey: video.storage_key!,
      mimeType: video.mime_type,
    });

    return {
      videoId: video.id,
      shortCode: video.short_code,
      status: VideoStatus.PROCESSING,
      jobId,
    };
  }

  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.requireOwnedDraftVideo(userId, videoId);
    await this.storageService.abortMultipartUpload(
      video.storage_key!,
      video.upload_id!,
    );
    await this.videoRepository.delete({
      id: video.id,
      status: VideoStatus.DRAFT,
    });
  }

  private async createDraftVideoWithUniqueShortCode(
    channelId: string,
    dto: InitiateUploadDto,
  ): Promise<Video> {
    for (let attempt = 0; attempt < MAX_SHORT_CODE_RETRIES; attempt++) {
      const entity = this.videoRepository.create({
        channel_id: channelId,
        short_code: generateShortCode(),
        title: dto.title,
        original_filename: dto.filename,
        status: VideoStatus.DRAFT,
        mime_type: dto.mimeType,
        size_bytes: String(dto.sizeBytes),
      });

      try {
        return await this.videoRepository.save(entity);
      } catch (err) {
        if (
          isPgUniqueViolationOnShortCode(err) &&
          attempt < MAX_SHORT_CODE_RETRIES - 1
        ) {
          continue;
        }
        throw err;
      }
    }

    throw new Error(
      'Could not allocate a unique video short code after maximum retries',
    );
  }

  private async requireOwnedDraftVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.channel_id !== channel.id) {
      throw new VideoAccessDeniedException();
    }

    if (
      video.status !== VideoStatus.DRAFT ||
      !video.upload_id ||
      !video.storage_key
    ) {
      throw new VideoInvalidStateException();
    }

    return video;
  }
}
