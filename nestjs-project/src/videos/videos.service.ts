import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Readable } from 'node:stream';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidRangeException,
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { S3StorageService } from '../storage/s3-storage.service';
import { Video, VideoStatus } from './entities/video.entity';

export interface ParsedByteRange {
  start: number;
  end: number;
}

export interface VideoStreamPayload {
  stream: Readable;
  contentType: string;
  contentLength: number;
  totalSize: number;
  isPartial: boolean;
  contentRange?: string;
}

export interface VideoDownloadPayload {
  stream: Readable;
  contentType: string;
  contentLength: number;
  filename: string;
}

export interface VideoThumbnailPayload {
  stream: Readable;
  contentType: string;
  contentLength?: number;
}

function sanitizeDownloadFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? 'video.mp4';
  const cleaned = base.replace(/["\r\n]/g, '').trim();
  return cleaned.length > 0 ? cleaned : 'video.mp4';
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

    if (video.status !== VideoStatus.READY || !video.storage_key) {
      throw new VideoNotReadyException();
    }

    return video;
  }

  parseByteRange(rangeHeader: string, totalSize: number): ParsedByteRange {
    if (totalSize <= 0) {
      throw new InvalidRangeException();
    }

    const trimmed = rangeHeader.trim();
    if (!trimmed.startsWith('bytes=') || trimmed.includes(',')) {
      throw new InvalidRangeException();
    }

    const spec = trimmed.slice('bytes='.length);
    const match = /^(\d*)-(\d*)$/.exec(spec);
    if (!match) {
      throw new InvalidRangeException();
    }

    const [, startStr, endStr] = match;
    if (!startStr && !endStr) {
      throw new InvalidRangeException();
    }

    // Suffix-byte-range-spec: bytes=-N (last N bytes)
    if (!startStr && endStr) {
      const suffixLength = Number(endStr);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        throw new InvalidRangeException();
      }
      const start = Math.max(0, totalSize - suffixLength);
      return { start, end: totalSize - 1 };
    }

    const start = Number(startStr);
    if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) {
      throw new InvalidRangeException();
    }

    const end = endStr
      ? Math.min(Number(endStr), totalSize - 1)
      : totalSize - 1;
    if (!Number.isSafeInteger(end) || end < start) {
      throw new InvalidRangeException();
    }

    return { start, end };
  }

  async getVideoStream(
    shortCode: string,
    rangeHeader?: string,
  ): Promise<VideoStreamPayload> {
    const video = await this.getReadyVideoByShortCode(shortCode);
    const totalSize = Number(video.size_bytes);

    if (rangeHeader) {
      const { start, end } = this.parseByteRange(rangeHeader, totalSize);
      const range = `bytes=${start}-${end}`;
      const res = await this.storageService.getObjectStream(
        video.storage_key!,
        range,
      );
      return {
        stream: res.stream,
        contentType: video.mime_type,
        contentLength: end - start + 1,
        totalSize,
        isPartial: true,
        contentRange: `bytes ${start}-${end}/${totalSize}`,
      };
    }

    const res = await this.storageService.getObjectStream(video.storage_key!);
    return {
      stream: res.stream,
      contentType: video.mime_type,
      contentLength: res.contentLength ?? totalSize,
      totalSize,
      isPartial: false,
    };
  }

  async getVideoDownload(shortCode: string): Promise<VideoDownloadPayload> {
    const video = await this.getReadyVideoByShortCode(shortCode);
    const res = await this.storageService.getObjectStream(video.storage_key!);

    return {
      stream: res.stream,
      contentType: video.mime_type,
      contentLength: res.contentLength ?? Number(video.size_bytes),
      filename: sanitizeDownloadFilename(video.original_filename),
    };
  }

  async getThumbnailStream(shortCode: string): Promise<VideoThumbnailPayload> {
    const video = await this.getReadyVideoByShortCode(shortCode);
    if (!video.thumbnail_key) {
      throw new VideoNotReadyException();
    }

    const res = await this.storageService.getObjectStream(video.thumbnail_key);
    return {
      stream: res.stream,
      contentType: res.contentType ?? 'image/jpeg',
      contentLength: res.contentLength,
    };
  }
}
