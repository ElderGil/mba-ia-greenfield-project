import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Readable } from 'node:stream';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidRangeException,
  VideoAccessDeniedException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { S3StorageService } from '../storage/s3-storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService', () => {
  let service: VideosService;

  const mockVideoRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  const mockChannelsService = {
    findByUserId: jest.fn(),
  };

  const mockStorageService = {
    getObjectStream: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: mockVideoRepo },
        { provide: ChannelsService, useValue: mockChannelsService },
        { provide: S3StorageService, useValue: mockStorageService },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('parseByteRange', () => {
    it('parses closed range bytes=0-1023', () => {
      expect(service.parseByteRange('bytes=0-1023', 5000)).toEqual({
        start: 0,
        end: 1023,
      });
    });

    it('clamps open-ended or oversized end range to totalSize - 1', () => {
      expect(service.parseByteRange('bytes=4000-', 5000)).toEqual({
        start: 4000,
        end: 4999,
      });
      expect(service.parseByteRange('bytes=4000-99999', 5000)).toEqual({
        start: 4000,
        end: 4999,
      });
    });

    it('parses suffix range bytes=-500', () => {
      expect(service.parseByteRange('bytes=-500', 5000)).toEqual({
        start: 4500,
        end: 4999,
      });
    });

    it('treats a suffix longer than the file as the whole file, even beyond 2^53', () => {
      expect(service.parseByteRange('bytes=-6000', 5000)).toEqual({
        start: 0,
        end: 4999,
      });
      expect(
        service.parseByteRange('bytes=-99999999999999999999', 5000),
      ).toEqual({ start: 0, end: 4999 });
    });

    it('carries Content-Range: bytes */size on an unsatisfiable range (RFC 9110)', () => {
      let thrown: unknown;
      try {
        service.parseByteRange('bytes=6000-', 5000);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(InvalidRangeException);
      expect((thrown as InvalidRangeException).headers).toEqual({
        'Content-Range': 'bytes */5000',
      });
    });

    it.each([
      ['items=0-10', 5000],
      ['bytes=0-10,20-30', 5000],
      ['bytes=5000-5010', 5000],
      ['bytes=200-100', 5000],
      ['bytes=-0', 5000],
      ['bytes=-', 5000],
      ['bytes=0-10', 0],
    ])('rejects invalid range "%s" for size %d', (header, size) => {
      expect(() => service.parseByteRange(header, size)).toThrow(
        InvalidRangeException,
      );
    });
  });

  describe('ownership and readiness guards', () => {
    it('throws ChannelNotFoundException when user has no channel', async () => {
      mockChannelsService.findByUserId.mockResolvedValue(null);
      await expect(service.listChannelVideos('u1')).rejects.toThrow(
        ChannelNotFoundException,
      );
    });

    it('throws VideoAccessDeniedException when querying another channel video', async () => {
      mockChannelsService.findByUserId.mockResolvedValue({ id: 'c1' });
      mockVideoRepo.findOne.mockResolvedValue({
        id: 'v1',
        channel_id: 'c2',
      });

      await expect(service.getVideoByIdForOwner('u1', 'v1')).rejects.toThrow(
        VideoAccessDeniedException,
      );
    });

    it('throws VideoNotFoundException when shortCode is missing', async () => {
      mockVideoRepo.findOne.mockResolvedValue(null);
      await expect(service.getReadyVideoByShortCode('missing')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('hides a video that is not ready behind VideoNotFoundException', async () => {
      mockVideoRepo.findOne.mockResolvedValue({
        id: 'v1',
        short_code: 'abc12345678',
        status: VideoStatus.PROCESSING,
        storage_key: 'videos/c1/v1/original.mp4',
      });

      await expect(
        service.getReadyVideoByShortCode('abc12345678'),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('getVideoStream & getVideoDownload', () => {
    it('returns partial stream metadata when Range header is provided', async () => {
      mockVideoRepo.findOne.mockResolvedValue({
        id: 'v1',
        short_code: 'abc12345678',
        status: VideoStatus.READY,
        storage_key: 'videos/c1/v1/original.mp4',
        mime_type: 'video/mp4',
        size_bytes: '1000',
      });
      mockStorageService.getObjectStream.mockResolvedValue({
        stream: Readable.from(Buffer.from('0123456789')),
        contentLength: 10,
        contentRange: 'bytes 0-9/1000',
        contentType: 'video/mp4',
      });

      const res = await service.getVideoStream('abc12345678', 'bytes=0-9');
      expect(mockStorageService.getObjectStream).not.toHaveBeenCalled();
      await res.open();

      expect(mockStorageService.getObjectStream).toHaveBeenCalledWith(
        'videos/c1/v1/original.mp4',
        'bytes=0-9',
      );
      expect(res.isPartial).toBe(true);
      expect(res.contentLength).toBe(10);
      expect(res.contentRange).toBe('bytes 0-9/1000');
    });

    it('returns the stored filename and size without opening storage in getVideoDownload', async () => {
      mockVideoRepo.findOne.mockResolvedValue({
        id: 'v1',
        short_code: 'abc12345678',
        status: VideoStatus.READY,
        storage_key: 'videos/c1/v1/original.mp4',
        original_filename: 'Aula 01 – Introdução.mp4',
        mime_type: 'video/mp4',
        size_bytes: '100',
      });

      const res = await service.getVideoDownload('abc12345678');

      // Header encoding is the HTTP layer's job (buildContentDisposition).
      expect(res.filename).toBe('Aula 01 – Introdução.mp4');
      expect(res.contentLength).toBe(100);
      expect(mockStorageService.getObjectStream).not.toHaveBeenCalled();
    });
  });
});
