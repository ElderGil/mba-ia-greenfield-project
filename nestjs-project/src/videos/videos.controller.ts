import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { SignUploadPartDto } from './dto/sign-upload-part.dto';
import {
  CompleteUploadResponseDto,
  InitiateUploadResponseDto,
  SignUploadPartResponseDto,
  VideoOwnerResponseDto,
  VideoPublicResponseDto,
} from './dto/video-response.dto';
import { buildContentDisposition, sendMedia } from './videos-http.util';
import { INITIATE_UPLOAD_THROTTLE } from './videos.constants';
import { VideosUploadService } from './videos-upload.service';
import { VideosService } from './videos.service';

@SkipThrottle()
@ApiTags('videos')
@Controller('videos')
export class VideosController {
  private readonly logger = new Logger(VideosController.name);

  constructor(
    private readonly videosUploadService: VideosUploadService,
    private readonly videosService: VideosService,
  ) {}

  @Post('uploads/initiate')
  @SkipThrottle({ default: false })
  @Throttle({ default: INITIATE_UPLOAD_THROTTLE })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate multipart video upload',
    description:
      'Creates a draft video record with a unique short code and initiates an S3/MinIO multipart upload for files up to 10 GiB.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft video created and multipart upload initiated',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Channel not found for user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Video size exceeds 10 GiB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Unsupported media type',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Channel already has the maximum number of open uploads',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 429,
    description: 'Too many upload initiations; retry later',
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosUploadService.initiateUpload(user.sub, dto);
  }

  @Post(':id/uploads/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Get presigned URL for a multipart upload part',
    description:
      'Generates a short-lived presigned PUT URL so the client uploads the part directly to object storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned upload part URL generated',
    type: SignUploadPartResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid UUID or partNumber',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signUploadPart(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignUploadPartDto,
  ): Promise<SignUploadPartResponseDto> {
    return this.videosUploadService.signUploadPart(
      user.sub,
      id,
      dto.partNumber,
    );
  }

  @Post(':id/uploads/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Complete multipart upload and enqueue processing',
    description:
      'Assembles multipart upload in S3/MinIO, transitions video from draft to processing, and enqueues BullMQ FFmpeg processing.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed and video queued for background processing',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid or rejected upload parts',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Completed object size exceeds 10 GiB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosUploadService.completeUpload(user.sub, id, dto.parts);
  }

  @Post(':id/uploads/abort')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Abort multipart upload and discard draft',
    description:
      'Aborts an active multipart upload in S3/MinIO and deletes the uncompleted draft record.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted and draft removed' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.videosUploadService.abortUpload(user.sub, id);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List videos of authenticated user channel',
    description:
      'Returns all videos (draft, processing, ready, failed) belonging to the caller channel.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of channel videos',
    type: [VideoOwnerResponseDto],
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listMyVideos(
    @CurrentUser() user: JwtPayload,
  ): Promise<VideoOwnerResponseDto[]> {
    const videos = await this.videosService.listChannelVideos(user.sub);
    return videos.map((v) => VideoOwnerResponseDto.fromEntity(v));
  }

  @Get(':id/status')
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Get owner video status and extracted metadata',
    description:
      'Allows the channel owner to poll processing state, metadata, and failure diagnostics.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video status and metadata',
    type: VideoOwnerResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideoStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoOwnerResponseDto> {
    const video = await this.videosService.getVideoByIdForOwner(user.sub, id);
    return VideoOwnerResponseDto.fromEntity(video);
  }

  @Public()
  @Get(':shortCode')
  @ApiOperation({
    summary: 'Get public video metadata by unique short code',
    description:
      'Returns metadata and playback/download/thumbnail URLs for a ready video.',
  })
  @ApiResponse({
    status: 200,
    description: 'Ready video metadata',
    type: VideoPublicResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getPublicVideo(
    @Param('shortCode') shortCode: string,
  ): Promise<VideoPublicResponseDto> {
    const video = await this.videosService.getReadyVideoByShortCode(shortCode);
    return VideoPublicResponseDto.fromEntity(video);
  }

  @Public()
  @Get(':shortCode/stream')
  @ApiOperation({
    summary: 'Stream video content with HTTP Byte-Range support',
    description:
      'Streams a ready video via 206 Partial Content when a Range header is supplied, or 200 OK otherwise.',
  })
  @ApiHeader({
    name: 'Range',
    required: false,
    description: 'Byte range (e.g., bytes=0-1048575)',
  })
  @ApiResponse({ status: 206, description: 'Partial video byte stream' })
  @ApiResponse({ status: 200, description: 'Full video byte stream' })
  @ApiResponse({
    status: 304,
    description: 'Not modified (If-None-Match matched the ETag)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 416,
    description: 'Invalid or unsatisfiable byte range',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async streamVideo(
    @Param('shortCode') shortCode: string,
    @Headers('range') range: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const payload = await this.videosService.getVideoStream(shortCode, range);
    const headers: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Content-Type': payload.contentType,
      'Content-Length': String(payload.contentLength),
    };
    if (payload.isPartial && payload.contentRange) {
      headers['Content-Range'] = payload.contentRange;
    }
    await sendMedia(
      req,
      res,
      {
        status: payload.isPartial ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK,
        headers,
        open: payload.open,
        etag: payload.etag,
      },
      (err) => this.logSourceError(shortCode, err),
    );
  }

  @Public()
  @Get(':shortCode/download')
  @ApiOperation({
    summary: 'Download video file as attachment',
    description:
      'Streams the full video file with Content-Disposition: attachment.',
  })
  @ApiResponse({ status: 200, description: 'Video file download stream' })
  @ApiResponse({
    status: 304,
    description: 'Not modified (If-None-Match matched the ETag)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async downloadVideo(
    @Param('shortCode') shortCode: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const payload = await this.videosService.getVideoDownload(shortCode);
    await sendMedia(
      req,
      res,
      {
        status: HttpStatus.OK,
        headers: {
          'Content-Type': payload.contentType,
          'Content-Length': String(payload.contentLength),
          'Content-Disposition': buildContentDisposition(payload.filename),
        },
        open: payload.open,
        etag: payload.etag,
      },
      (err) => this.logSourceError(shortCode, err),
    );
  }

  @Public()
  @Get(':shortCode/thumbnail')
  @ApiOperation({
    summary: 'Get generated JPEG thumbnail for a ready video',
    description:
      'Streams the JPEG thumbnail extracted from the video frame during background processing.',
  })
  @ApiResponse({ status: 200, description: 'JPEG thumbnail image' })
  @ApiResponse({
    status: 304,
    description: 'Not modified (If-None-Match matched the ETag)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getThumbnail(
    @Param('shortCode') shortCode: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const payload = await this.videosService.getThumbnailStream(shortCode);
    await sendMedia(
      req,
      res,
      {
        status: HttpStatus.OK,
        headers: { 'Content-Type': payload.contentType },
        open: payload.open,
        etag: payload.etag,
      },
      (err) => this.logSourceError(shortCode, err),
    );
  }

  private logSourceError(shortCode: string, err: Error): void {
    this.logger.warn(
      `Storage stream for video ${shortCode} failed mid-response: ${err.message}`,
    );
  }
}
