import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidUploadPartsException,
  TooManyOpenUploadsException,
  UnsupportedMediaTypeException,
  UploadLimitExceededException,
  VideoAccessDeniedException,
  VideoInvalidStateException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { S3StorageService } from '../storage/s3-storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosQueueService } from './videos-queue.service';
import { VideosUploadService } from './videos-upload.service';

describe('VideosUploadService', () => {
  let service: VideosUploadService;

  const mockVideoRepo = {
    create: jest.fn((input: Partial<Video>) => ({ ...input })),
    save: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
  };

  const mockChannelsService = {
    findByUserId: jest.fn(),
  };

  const mockStorageService = {
    createMultipartUpload: jest.fn(),
    getPresignedPartUrl: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
  };

  const mockQueueService = {
    enqueueProcessVideo: jest.fn(),
  };

  const cfg = {
    maxFileSizeBytes: 10 * 1024 * 1024 * 1024,
    defaultPartSizeBytes: 10 * 1024 * 1024,
    presignedUrlExpiresInSeconds: 900,
    maxOpenDrafts: 5,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockVideoRepo.count.mockResolvedValue(0);
    const module = await Test.createTestingModule({
      providers: [
        VideosUploadService,
        { provide: getRepositoryToken(Video), useValue: mockVideoRepo },
        { provide: ChannelsService, useValue: mockChannelsService },
        { provide: S3StorageService, useValue: mockStorageService },
        { provide: VideosQueueService, useValue: mockQueueService },
        { provide: videoConfig.KEY, useValue: cfg },
      ],
    }).compile();

    service = module.get(VideosUploadService);
  });

  describe('initiateUpload', () => {
    it('should refuse a new upload once the channel has maxOpenDrafts open drafts, before touching S3', async () => {
      mockChannelsService.findByUserId.mockResolvedValue({ id: 'chan-1' });
      mockVideoRepo.count.mockResolvedValue(5);

      await expect(
        service.initiateUpload('u1', {
          title: 'One too many',
          filename: 'a.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
        }),
      ).rejects.toThrow(TooManyOpenUploadsException);
      expect(mockVideoRepo.count).toHaveBeenCalledWith({
        where: { channel_id: 'chan-1', status: VideoStatus.DRAFT },
      });
      expect(mockStorageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('rejects unsupported MIME types with UnsupportedMediaTypeException', async () => {
      await expect(
        service.initiateUpload('u1', {
          title: 'Bad',
          filename: 'doc.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
        }),
      ).rejects.toThrow(UnsupportedMediaTypeException);
      expect(mockChannelsService.findByUserId).not.toHaveBeenCalled();
    });

    it('rejects files over 10 GiB with UploadLimitExceededException', async () => {
      await expect(
        service.initiateUpload('u1', {
          title: 'Huge',
          filename: 'huge.mp4',
          mimeType: 'video/mp4',
          sizeBytes: cfg.maxFileSizeBytes + 1,
        }),
      ).rejects.toThrow(UploadLimitExceededException);
      expect(mockChannelsService.findByUserId).not.toHaveBeenCalled();
    });

    it('throws ChannelNotFoundException when user has no channel', async () => {
      mockChannelsService.findByUserId.mockResolvedValue(null);

      await expect(
        service.initiateUpload('u1', {
          title: 'Demo',
          filename: 'demo.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 2048,
        }),
      ).rejects.toThrow(ChannelNotFoundException);
    });

    it('retries short_code collision and compensates draft on S3 failure', async () => {
      mockChannelsService.findByUserId.mockResolvedValue({ id: 'chan-1' });
      const uniqueErr = new QueryFailedError('INSERT', [], new Error('dup'));
      Object.assign(uniqueErr, {
        code: '23505',
        detail: 'Key (short_code)=(abc) already exists.',
      });

      mockVideoRepo.save
        .mockRejectedValueOnce(uniqueErr)
        .mockResolvedValueOnce({
          id: 'vid-1',
          channel_id: 'chan-1',
          short_code: 'AbCdEf12345',
          status: VideoStatus.DRAFT,
        });
      mockStorageService.createMultipartUpload.mockRejectedValueOnce(
        new Error('S3 down'),
      );

      await expect(
        service.initiateUpload('u1', {
          title: 'Demo',
          filename: 'demo.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 2048,
        }),
      ).rejects.toThrow('S3 down');

      expect(mockVideoRepo.save).toHaveBeenCalledTimes(2);
      expect(mockVideoRepo.delete).toHaveBeenCalledWith({ id: 'vid-1' });
    });

    it('creates draft video and initiates S3 multipart upload', async () => {
      mockChannelsService.findByUserId.mockResolvedValue({ id: 'chan-1' });
      mockVideoRepo.save.mockImplementation((v: Partial<Video>) =>
        Promise.resolve({ id: 'vid-1', ...v }),
      );
      mockStorageService.createMultipartUpload.mockResolvedValue('upload-123');

      const result = await service.initiateUpload('u1', {
        title: 'My Video',
        filename: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 5000,
      });

      expect(result.videoId).toBe('vid-1');
      expect(result.shortCode).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.uploadId).toBe('upload-123');
      expect(result.storageKey).toBe('videos/chan-1/vid-1/original.mp4');
      expect(result.partSizeBytes).toBe(cfg.defaultPartSizeBytes);
      expect(result.maxParts).toBe(10000);
    });
  });

  describe('signUploadPart / completeUpload / abortUpload guards', () => {
    it('throws VideoNotFoundException when video does not exist', async () => {
      mockChannelsService.findByUserId.mockResolvedValue({ id: 'chan-1' });
      mockVideoRepo.findOne.mockResolvedValue(null);

      await expect(service.signUploadPart('u1', 'missing', 1)).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('throws VideoAccessDeniedException for another channel video', async () => {
      mockChannelsService.findByUserId.mockResolvedValue({ id: 'chan-1' });
      mockVideoRepo.findOne.mockResolvedValue({
        id: 'vid-1',
        channel_id: 'chan-other',
        status: VideoStatus.DRAFT,
        upload_id: 'up-1',
        storage_key: 'videos/chan-other/vid-1/original.mp4',
      });

      await expect(service.signUploadPart('u1', 'vid-1', 1)).rejects.toThrow(
        VideoAccessDeniedException,
      );
    });

    it('throws VideoInvalidStateException when video is not draft', async () => {
      mockChannelsService.findByUserId.mockResolvedValue({ id: 'chan-1' });
      mockVideoRepo.findOne.mockResolvedValue({
        id: 'vid-1',
        channel_id: 'chan-1',
        status: VideoStatus.PROCESSING,
        upload_id: null,
        storage_key: 'videos/chan-1/vid-1/original.mp4',
      });

      await expect(
        service.completeUpload('u1', 'vid-1', [
          { partNumber: 1, etag: '"e1"' },
        ]),
      ).rejects.toThrow(VideoInvalidStateException);
    });

    it('rejects duplicate part numbers on completeUpload', async () => {
      mockChannelsService.findByUserId.mockResolvedValue({ id: 'chan-1' });
      mockVideoRepo.findOne.mockResolvedValue({
        id: 'vid-1',
        channel_id: 'chan-1',
        status: VideoStatus.DRAFT,
        upload_id: 'up-1',
        storage_key: 'videos/chan-1/vid-1/original.mp4',
      });

      await expect(
        service.completeUpload('u1', 'vid-1', [
          { partNumber: 1, etag: '"e1"' },
          { partNumber: 1, etag: '"e2"' },
        ]),
      ).rejects.toThrow(InvalidUploadPartsException);
    });

    it('completes upload, updates status atomically, and enqueues BullMQ job', async () => {
      mockChannelsService.findByUserId.mockResolvedValue({ id: 'chan-1' });
      mockVideoRepo.findOne.mockResolvedValue({
        id: 'vid-1',
        channel_id: 'chan-1',
        short_code: 'ShortCode11',
        status: VideoStatus.DRAFT,
        upload_id: 'up-1',
        storage_key: 'videos/chan-1/vid-1/original.mp4',
        mime_type: 'video/mp4',
      });
      mockStorageService.completeMultipartUpload.mockResolvedValue(undefined);
      mockStorageService.headObject.mockResolvedValue({
        contentLength: 4096,
        contentType: 'video/mp4',
        etag: '"final"',
      });
      mockVideoRepo.update.mockResolvedValue({ affected: 1 });
      mockQueueService.enqueueProcessVideo.mockResolvedValue(
        'process-video-vid-1',
      );

      const res = await service.completeUpload('u1', 'vid-1', [
        { partNumber: 1, etag: '"e1"' },
      ]);

      expect(res).toEqual({
        videoId: 'vid-1',
        shortCode: 'ShortCode11',
        status: VideoStatus.PROCESSING,
        jobId: 'process-video-vid-1',
      });
      expect(mockQueueService.enqueueProcessVideo).toHaveBeenCalledWith({
        videoId: 'vid-1',
        channelId: 'chan-1',
        storageKey: 'videos/chan-1/vid-1/original.mp4',
        mimeType: 'video/mp4',
      });
    });

    describe('completeUpload failure paths', () => {
      const draftVideo = {
        id: 'vid-1',
        channel_id: 'chan-1',
        short_code: 'ShortCode11',
        status: VideoStatus.DRAFT,
        upload_id: 'up-1',
        storage_key: 'videos/chan-1/vid-1/original.mp4',
        mime_type: 'video/mp4',
      };
      const parts = [{ partNumber: 1, etag: '"e1"' }];

      beforeEach(() => {
        mockChannelsService.findByUserId.mockResolvedValue({ id: 'chan-1' });
        mockVideoRepo.findOne.mockResolvedValue({ ...draftVideo });
      });

      it('should throw VideoInvalidStateException without touching S3 when a concurrent complete already claimed the draft', async () => {
        mockVideoRepo.update.mockResolvedValue({ affected: 0 });

        await expect(
          service.completeUpload('u1', 'vid-1', parts),
        ).rejects.toThrow(VideoInvalidStateException);
        expect(
          mockStorageService.completeMultipartUpload,
        ).not.toHaveBeenCalled();
      });

      it('should revert the claim to draft when storage rejects the parts', async () => {
        mockVideoRepo.update.mockResolvedValue({ affected: 1 });
        mockStorageService.completeMultipartUpload.mockRejectedValue(
          Object.assign(new Error('bad part'), { name: 'InvalidPart' }),
        );

        await expect(
          service.completeUpload('u1', 'vid-1', parts),
        ).rejects.toThrow(InvalidUploadPartsException);
        expect(mockVideoRepo.update).toHaveBeenLastCalledWith(
          { id: 'vid-1', status: VideoStatus.PROCESSING },
          { status: VideoStatus.DRAFT },
        );
      });

      it('should mark the video failed when the completed object cannot be inspected', async () => {
        mockVideoRepo.update.mockResolvedValue({ affected: 1 });
        mockStorageService.completeMultipartUpload.mockResolvedValue(undefined);
        const storageDown = new Error('socket hang up');
        mockStorageService.headObject.mockRejectedValue(storageDown);

        await expect(
          service.completeUpload('u1', 'vid-1', parts),
        ).rejects.toThrow(storageDown);
        expect(mockQueueService.enqueueProcessVideo).not.toHaveBeenCalled();
        expect(mockVideoRepo.update).toHaveBeenLastCalledWith(
          { id: 'vid-1', status: VideoStatus.PROCESSING },
          {
            status: VideoStatus.FAILED,
            upload_id: null,
            processing_error: expect.stringContaining(
              'socket hang up',
            ) as string,
          },
        );
      });

      it('should mark the video failed before deleting an oversized object, even if the delete fails', async () => {
        mockVideoRepo.update.mockResolvedValue({ affected: 1 });
        mockStorageService.completeMultipartUpload.mockResolvedValue(undefined);
        mockStorageService.headObject.mockResolvedValue({
          contentLength: cfg.maxFileSizeBytes + 1,
          contentType: 'video/mp4',
        });
        const deleteFailed = new Error('delete timed out');
        mockStorageService.deleteObject.mockRejectedValue(deleteFailed);

        await expect(
          service.completeUpload('u1', 'vid-1', parts),
        ).rejects.toThrow(deleteFailed);
        expect(mockVideoRepo.update).toHaveBeenLastCalledWith(
          { id: 'vid-1', status: VideoStatus.PROCESSING },
          {
            status: VideoStatus.FAILED,
            upload_id: null,
            processing_error: 'Uploaded object exceeded maximum allowed size',
          },
        );
        expect(mockQueueService.enqueueProcessVideo).not.toHaveBeenCalled();
      });

      it('should mark the video failed when the processing job cannot be enqueued', async () => {
        mockVideoRepo.update.mockResolvedValue({ affected: 1 });
        mockStorageService.completeMultipartUpload.mockResolvedValue(undefined);
        mockStorageService.headObject.mockResolvedValue({
          contentLength: 4096,
          contentType: 'video/mp4',
        });
        const queueDown = new Error('Redis connection refused');
        mockQueueService.enqueueProcessVideo.mockRejectedValue(queueDown);

        await expect(
          service.completeUpload('u1', 'vid-1', parts),
        ).rejects.toThrow(queueDown);
        expect(mockVideoRepo.update).toHaveBeenLastCalledWith(
          { id: 'vid-1', status: VideoStatus.PROCESSING },
          {
            status: VideoStatus.FAILED,
            processing_error: expect.stringContaining(
              'Redis connection refused',
            ) as string,
          },
        );
      });
    });

    it('aborts multipart upload and deletes draft record', async () => {
      mockChannelsService.findByUserId.mockResolvedValue({ id: 'chan-1' });
      mockVideoRepo.findOne.mockResolvedValue({
        id: 'vid-1',
        channel_id: 'chan-1',
        status: VideoStatus.DRAFT,
        upload_id: 'up-1',
        storage_key: 'videos/chan-1/vid-1/original.mp4',
      });

      await service.abortUpload('u1', 'vid-1');

      expect(mockStorageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/chan-1/vid-1/original.mp4',
        'up-1',
      );
      expect(mockVideoRepo.delete).toHaveBeenCalledWith({
        id: 'vid-1',
        status: VideoStatus.DRAFT,
      });
    });
  });
});
