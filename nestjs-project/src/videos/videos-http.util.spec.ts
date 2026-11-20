import { validateHeaderValue } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import type { Response } from 'express';
import {
  buildContentDisposition,
  type MediaReply,
  sendMedia,
} from './videos-http.util';

function fakeResponse(): Response & PassThrough {
  const res = new PassThrough() as unknown as Response & PassThrough;
  res.status = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  return res;
}

function reply(open: MediaReply['open']): MediaReply {
  return {
    status: 200,
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4' },
    open,
  };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('videos-http.util', () => {
  describe('buildContentDisposition', () => {
    it('should keep plain ASCII names in both filename parameters', () => {
      expect(buildContentDisposition('sample.mp4')).toBe(
        `attachment; filename="sample.mp4"; filename*=UTF-8''sample.mp4`,
      );
    });

    it('should produce a valid header for names outside Latin-1', () => {
      const header = buildContentDisposition('Aula 01 – Introdução 🎬.mp4');

      expect(() =>
        validateHeaderValue('Content-Disposition', header),
      ).not.toThrow();
      expect(header).toContain('filename="Aula 01 _ Introducao _.mp4"');
      expect(header).toContain(
        `filename*=UTF-8''Aula%2001%20%E2%80%93%20Introdu%C3%A7%C3%A3o%20%F0%9F%8E%AC.mp4`,
      );
    });

    it('should strip quotes, backslashes, control characters and path segments', () => {
      const header = buildContentDisposition('../dir\\evil"na\u0007me\r\n.mp4');

      expect(() =>
        validateHeaderValue('Content-Disposition', header),
      ).not.toThrow();
      expect(header).toContain('filename="evilname.mp4"');
    });

    it('should fall back to video.mp4 when nothing usable is left', () => {
      expect(buildContentDisposition('"\r\n"')).toContain(
        'filename="video.mp4"',
      );
    });
  });

  describe('sendMedia', () => {
    it('should answer HEAD with headers only and never open the source', async () => {
      const res = fakeResponse();
      const open = jest.fn();

      await sendMedia({ method: 'HEAD' }, res, reply(open), jest.fn());

      expect(open).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Length', '4');
      expect(res.writableEnded).toBe(true);
    });

    it('should destroy the source when the client left while it was opening', async () => {
      const res = fakeResponse();
      const source = new PassThrough();
      const open = jest.fn(async () => {
        res.emit('close');
        return Promise.resolve({ stream: source });
      });

      await sendMedia({ method: 'GET' }, res, reply(open), jest.fn());

      expect(source.destroyed).toBe(true);
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('should not set media headers when opening the source fails', async () => {
      const res = fakeResponse();
      const open = jest.fn().mockRejectedValue(new Error('NoSuchKey'));

      await expect(
        sendMedia({ method: 'GET' }, res, reply(open), jest.fn()),
      ).rejects.toThrow('NoSuchKey');
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('should tear the response down and report when the source fails mid-body', async () => {
      const res = fakeResponse();
      const source = new PassThrough();
      const onError = jest.fn();

      await sendMedia(
        { method: 'GET' },
        res,
        reply(() => Promise.resolve({ stream: source })),
        onError,
      );
      source.write('ab');
      source.destroy(new Error('ECONNRESET'));
      await flush();

      expect(res.destroyed).toBe(true);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'ECONNRESET' }),
      );
    });

    it('should destroy the source and stay quiet when the client aborts mid-body', async () => {
      const res = fakeResponse();
      const source = new PassThrough();
      const onError = jest.fn();

      await sendMedia(
        { method: 'GET' },
        res,
        reply(() => Promise.resolve({ stream: source })),
        onError,
      );
      res.destroy();
      await flush();

      expect(source.destroyed).toBe(true);
      expect(onError).not.toHaveBeenCalled();
    });

    it('should add Content-Length from the opened source when it was unknown', async () => {
      const res = fakeResponse();

      await sendMedia(
        { method: 'GET' },
        res,
        {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
          open: () =>
            Promise.resolve({
              stream: Readable.from([Buffer.from('jpeg')]),
              contentLength: 4,
            }),
        },
        jest.fn(),
      );

      expect(res.setHeader).toHaveBeenCalledWith('Content-Length', '4');
    });
  });
});
