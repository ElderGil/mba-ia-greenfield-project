import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { S3StorageService } from '../storage/s3-storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { MediaProcessorService } from './media-processor.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import type { VideoProcessingJobData } from './videos-queue.constants';

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;

  const mockVideoRepo = {
    findOne: jest.fn(),
    update: jest.fn(),
  };

  const mockStorageService = {
    getPresignedGetUrl: jest.fn(),
    putObject: jest.fn(),
  };

  const mockMediaProcessor = {
    probeVideo: jest.fn(),
    generateThumbnail: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: getRepositoryToken(Video), useValue: mockVideoRepo },
        { provide: S3StorageService, useValue: mockStorageService },
        { provide: MediaProcessorService, useValue: mockMediaProcessor },
      ],
    }).compile();

    processor = module.get(VideoProcessingProcessor);
  });

  const job = {
    id: 'process-video-v1',
    data: {
      videoId: 'v1',
      channelId: 'c1',
      storageKey: 'videos/c1/v1/original.mp4',
      mimeType: 'video/mp4',
    },
    attemptsMade: 1,
    opts: { attempts: 3 },
  } as unknown as Job<VideoProcessingJobData>;

  it('probes video, uploads thumbnail, and marks video ready', async () => {
    mockVideoRepo.findOne.mockResolvedValue({
      id: 'v1',
      mime_type: 'video/webm',
    });
    mockStorageService.getPresignedGetUrl.mockResolvedValue(
      'http://minio:9000/signed',
    );
    mockMediaProcessor.probeVideo.mockResolvedValue({
      durationSeconds: 12.5,
      width: 1920,
      height: 1080,
      codec: 'h264',
    });
    const thumb = Buffer.from([0xff, 0xd8, 0xff]);
    mockMediaProcessor.generateThumbnail.mockResolvedValue(thumb);

    await processor.process(job);

    // The stored MIME (not auto-detection) drives the demuxer.
    expect(mockMediaProcessor.probeVideo).toHaveBeenCalledWith(
      'http://minio:9000/signed',
      'video/webm',
    );
    expect(mockMediaProcessor.generateThumbnail).toHaveBeenCalledWith(
      'http://minio:9000/signed',
      12.5,
      'video/webm',
    );
    expect(mockStorageService.putObject).toHaveBeenCalledWith(
      'thumbnails/c1/v1/thumb.jpg',
      thumb,
      'image/jpeg',
    );
    expect(mockVideoRepo.update).toHaveBeenCalledWith(
      { id: 'v1' },
      {
        status: VideoStatus.READY,
        thumbnail_key: 'thumbnails/c1/v1/thumb.jpg',
        duration_seconds: 12.5,
        width: 1920,
        height: 1080,
        codec: 'h264',
        processing_error: null,
      },
    );
  });

  it('skips processing when video record no longer exists', async () => {
    mockVideoRepo.findOne.mockResolvedValue(null);

    await processor.process(job);

    expect(mockStorageService.getPresignedGetUrl).not.toHaveBeenCalled();
    expect(mockVideoRepo.update).not.toHaveBeenCalled();
  });

  it('does not mark failed while retry attempts remain', async () => {
    await processor.onFailed(job, new Error('transient error'));
    expect(mockVideoRepo.update).not.toHaveBeenCalled();
  });

  it('marks video failed when BullMQ fails the job for good before attempts run out (stalled job)', async () => {
    // BullMQ moves a job that stalled more than maxStalledCount straight to
    // failed with an UnrecoverableError, whatever attemptsMade says.
    await processor.onFailed(
      job,
      new UnrecoverableError('job stalled more than allowable limit'),
    );

    expect(mockVideoRepo.update).toHaveBeenCalledWith(
      { id: 'v1' },
      {
        status: VideoStatus.FAILED,
        processing_error: 'job stalled more than allowable limit',
      },
    );
  });

  it('marks video failed once max attempts are exhausted', async () => {
    const exhaustedJob = {
      ...job,
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as unknown as Job<VideoProcessingJobData>;

    await processor.onFailed(exhaustedJob, new Error('corrupt stream'));

    expect(mockVideoRepo.update).toHaveBeenCalledWith(
      { id: 'v1' },
      {
        status: VideoStatus.FAILED,
        processing_error: 'corrupt stream',
      },
    );
  });
});
