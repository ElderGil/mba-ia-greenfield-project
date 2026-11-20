import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidRangeException,
  VideoAccessDeniedException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { S3StorageService } from '../storage/s3-storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import type { OpenedMedia } from './videos-http.util';

export interface ParsedByteRange {
  start: number;
  end: number;
}

// Storage is opened lazily (open) so HEAD requests and requests rejected
// before the body never touch the object store.
export interface VideoStreamPayload {
  open: () => Promise<OpenedMedia>;
  etag: string;
  contentType: string;
  contentLength: number;
  totalSize: number;
  isPartial: boolean;
  contentRange?: string;
}

export interface VideoDownloadPayload {
  open: () => Promise<OpenedMedia>;
  etag: string;
  contentType: string;
  contentLength: number;
  filename: string;
}

export interface VideoThumbnailPayload {
  open: () => Promise<OpenedMedia>;
  etag: string;
  contentType: string;
  contentLength?: number;
}

// A ready video's bytes never change (there is no re-upload), so id + size
// is a stable strong validator.
function mediaEtag(video: Video): string {
  return `"${video.id}-${video.size_bytes}"`;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: S3StorageService,
  ) {}

  async listChannelVideos(userId: string): Promise<Video[]> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    return this.videoRepository.find({
      where: { channel_id: channel.id },
      order: { created_at: 'DESC' },
    });
  }

  async getVideoByIdForOwner(userId: string, videoId: string): Promise<Video> {
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

    return video;
  }

  async getReadyVideoByShortCode(shortCode: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { short_code: shortCode },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    // Public routes must not reveal that an unpublished shortCode exists.
    if (video.status !== VideoStatus.READY || !video.storage_key) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  parseByteRange(rangeHeader: string, totalSize: number): ParsedByteRange {
    if (totalSize <= 0) {
      throw new InvalidRangeException(totalSize);
    }

    const trimmed = rangeHeader.trim();
    if (!trimmed.startsWith('bytes=') || trimmed.includes(',')) {
      throw new InvalidRangeException(totalSize);
    }

    const spec = trimmed.slice('bytes='.length);
    const match = /^(\d*)-(\d*)$/.exec(spec);
    if (!match) {
      throw new InvalidRangeException(totalSize);
    }

    const [, startStr, endStr] = match;
    if (!startStr && !endStr) {
      throw new InvalidRangeException(totalSize);
    }

    // Suffix-byte-range-spec: bytes=-N (last N bytes)
    if (!startStr && endStr) {
      // Digits beyond 2^53 still mean "more than the whole file" (RFC 9110).
      const suffixLength = Number(endStr);
      if (suffixLength <= 0) {
        throw new InvalidRangeException(totalSize);
      }
      const start = Number.isSafeInteger(suffixLength)
        ? Math.max(0, totalSize - suffixLength)
        : 0;
      return { start, end: totalSize - 1 };
    }

    const start = Number(startStr);
    if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) {
      throw new InvalidRangeException(totalSize);
    }

    const end = endStr
      ? Math.min(Number(endStr), totalSize - 1)
      : totalSize - 1;
    if (!Number.isSafeInteger(end) || end < start) {
      throw new InvalidRangeException(totalSize);
    }

    return { start, end };
  }

  /**
   * @param selectRange given the media ETag, returns the Range header to
   *   honour (or undefined for the full file); the HTTP layer decides it
   *   because conditionals are evaluated before Range (selectRange()).
   */
  async getVideoStream(
    shortCode: string,
    selectRange: (etag: string) => string | undefined = () => undefined,
  ): Promise<VideoStreamPayload> {
    const video = await this.getReadyVideoByShortCode(shortCode);
    const totalSize = Number(video.size_bytes);
    const etag = mediaEtag(video);
    const rangeHeader = selectRange(etag);

    const storageKey = video.storage_key!;

    if (rangeHeader) {
      const { start, end } = this.parseByteRange(rangeHeader, totalSize);
      const range = `bytes=${start}-${end}`;
      return {
        open: () => this.storageService.getObjectStream(storageKey, range),
        etag,
        contentType: video.mime_type,
        contentLength: end - start + 1,
        totalSize,
        isPartial: true,
        contentRange: `bytes ${start}-${end}/${totalSize}`,
      };
    }

    return {
      open: () => this.storageService.getObjectStream(storageKey),
      etag,
      contentType: video.mime_type,
      contentLength: totalSize,
      totalSize,
      isPartial: false,
    };
  }

  async getVideoDownload(shortCode: string): Promise<VideoDownloadPayload> {
    const video = await this.getReadyVideoByShortCode(shortCode);
    const storageKey = video.storage_key!;

    return {
      open: () => this.storageService.getObjectStream(storageKey),
      etag: mediaEtag(video),
      contentType: video.mime_type,
      contentLength: Number(video.size_bytes),
      filename: video.original_filename,
    };
  }

  async getThumbnailStream(shortCode: string): Promise<VideoThumbnailPayload> {
    const video = await this.getReadyVideoByShortCode(shortCode);
    if (!video.thumbnail_key) {
      throw new VideoNotFoundException();
    }

    const thumbnailKey = video.thumbnail_key;
    return {
      open: () => this.storageService.getObjectStream(thumbnailKey),
      etag: `"${video.id}-thumb"`,
      contentType: 'image/jpeg',
    };
  }
}
