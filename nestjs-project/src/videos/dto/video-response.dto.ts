import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Video, VideoStatus } from '../entities/video.entity';

export class InitiateUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  videoId: string;

  @ApiProperty({ example: 'aB3dE6gH9jK' })
  shortCode: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty()
  uploadId: string;

  @ApiProperty()
  storageKey: string;

  @ApiProperty({ example: 10485760 })
  partSizeBytes: number;

  @ApiProperty({ example: 10000 })
  maxParts: number;
}

export class SignUploadPartResponseDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty()
  presignedUrl: string;

  @ApiProperty({ example: 900 })
  expiresInSeconds: number;
}

export class CompleteUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  videoId: string;

  @ApiProperty({ example: 'aB3dE6gH9jK' })
  shortCode: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.PROCESSING })
  status: VideoStatus;

  @ApiProperty({ example: 'process-video-uuid' })
  jobId: string;
}

export class VideoOwnerResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  channelId: string;

  @ApiProperty()
  shortCode: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  originalFilename: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty()
  mimeType: string;

  @ApiProperty()
  sizeBytes: number;

  @ApiPropertyOptional({ nullable: true })
  durationSeconds: number | null;

  @ApiPropertyOptional({ nullable: true })
  width: number | null;

  @ApiPropertyOptional({ nullable: true })
  height: number | null;

  @ApiPropertyOptional({ nullable: true })
  codec: string | null;

  @ApiPropertyOptional({ nullable: true })
  thumbnailKey: string | null;

  @ApiPropertyOptional({ nullable: true })
  processingError: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  static fromEntity(video: Video): VideoOwnerResponseDto {
    return {
      id: video.id,
      channelId: video.channel_id,
      shortCode: video.short_code,
      title: video.title,
      originalFilename: video.original_filename,
      status: video.status,
      mimeType: video.mime_type,
      sizeBytes: Number(video.size_bytes),
      durationSeconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      codec: video.codec,
      thumbnailKey: video.thumbnail_key,
      processingError: video.processing_error,
      createdAt: video.created_at,
      updatedAt: video.updated_at,
    };
  }
}

export class VideoPublicResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  shortCode: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty()
  mimeType: string;

  @ApiProperty()
  sizeBytes: number;

  @ApiPropertyOptional({ nullable: true })
  durationSeconds: number | null;

  @ApiPropertyOptional({ nullable: true })
  width: number | null;

  @ApiPropertyOptional({ nullable: true })
  height: number | null;

  @ApiPropertyOptional({ nullable: true })
  codec: string | null;

  @ApiProperty()
  streamUrl: string;

  @ApiProperty()
  downloadUrl: string;

  @ApiProperty()
  thumbnailUrl: string;

  @ApiProperty()
  createdAt: Date;

  static fromEntity(video: Video): VideoPublicResponseDto {
    return {
      id: video.id,
      shortCode: video.short_code,
      title: video.title,
      status: video.status,
      mimeType: video.mime_type,
      sizeBytes: Number(video.size_bytes),
      durationSeconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      codec: video.codec,
      streamUrl: `/videos/${video.short_code}/stream`,
      downloadUrl: `/videos/${video.short_code}/download`,
      thumbnailUrl: `/videos/${video.short_code}/thumbnail`,
      createdAt: video.created_at,
    };
  }
}
