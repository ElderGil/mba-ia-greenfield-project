import { validateHeaderValue } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import type { Response } from 'express';
import {
  buildContentDisposition,
  type MediaReply,
  selectRange,
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
  describe('selectRange', () => {
    const etag = '"vid-1-4096"';
    const get = (headers: Record<string, string>) => ({
      method: 'GET',
      headers,
    });

    it('should honour a byte range on GET', () => {
      expect(selectRange(get({ range: 'bytes=0-99' }), etag)).toBe(
        'bytes=0-99',
      );
    });

    it('should ignore Range on HEAD, the only method with range handling being GET', () => {
      expect(
        selectRange({ method: 'HEAD', headers: { range: 'bytes=0-99' } }, etag),
      ).toBeUndefined();
    });

    it('should ignore Range when If-None-Match matches, so the 304 wins over a 416', () => {
      expect(
        selectRange(
          get({ range: 'bytes=999999-', 'if-none-match': etag }),
          etag,
        ),
      ).toBeUndefined();
    });

    it('should honour Range when If-Range is a strong match for the current ETag', () => {
      expect(
        selectRange(get({ range: 'bytes=0-99', 'if-range': etag }), etag),
      ).toBe('bytes=0-99');
    });

    it.each([
      ['a different ETag', '"vid-1-1"'],
      ['a weak ETag', `W/${etag}`],
      [
        'an HTTP-date (no Last-Modified is sent)',
        'Wed, 21 Oct 2026 07:28:00 GMT',
      ],
    ])(
      'should send the full representation when If-Range is %s',
      (_, ifRange) => {
        expect(
          selectRange(get({ range: 'bytes=0-99', 'if-range': ifRange }), etag),
        ).toBeUndefined();
      },
    );

    it.each([['items=0-10'], ['bytes=0-10,20-30']])(
      'should ignore "%s" (unknown unit, or several ranges this endpoint does not serve)',
      (range) => {
        expect(selectRange(get({ range }), etag)).toBeUndefined();
      },
    );

    it('should leave a malformed or unsatisfiable byte range to the parser (416)', () => {
      expect(selectRange(get({ range: 'bytes=999999-' }), etag)).toBe(
        'bytes=999999-',
      );
    });
  });

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
    it('should answer 304 without opening the source when If-None-Match matches', async () => {
      const res = fakeResponse();
      const open = jest.fn();

      await sendMedia(
        { method: 'GET', headers: { 'if-none-match': 'W/"other", "v1-4"' } },
        res,
        { ...reply(open), etag: '"v1-4"' },
        jest.fn(),
      );

      expect(open).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(304);
      expect(res.setHeader).toHaveBeenCalledWith('ETag', '"v1-4"');
      expect(res.setHeader).not.toHaveBeenCalledWith('Content-Length', '4');
      expect(res.writableEnded).toBe(true);
    });

    it('should send ETag and Cache-Control with the body when the tag does not match', async () => {
      const res = fakeResponse();

      await sendMedia(
        { method: 'GET', headers: { 'if-none-match': '"stale"' } },
        res,
        {
          ...reply(() =>
            Promise.resolve({ stream: Readable.from([Buffer.from('abcd')]) }),
          ),
          etag: '"v1-4"',
        },
        jest.fn(),
      );

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.setHeader).toHaveBeenCalledWith('ETag', '"v1-4"');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    });

    it('should answer HEAD with headers only and never open the source', async () => {
      const res = fakeResponse();
      const open = jest.fn();

      await sendMedia(
        { method: 'HEAD', headers: {} },
        res,
        reply(open),
        jest.fn(),
      );

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

      await sendMedia(
        { method: 'GET', headers: {} },
        res,
        reply(open),
        jest.fn(),
      );

      expect(source.destroyed).toBe(true);
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('should not set media headers when opening the source fails', async () => {
      const res = fakeResponse();
      const open = jest.fn().mockRejectedValue(new Error('NoSuchKey'));

      await expect(
        sendMedia({ method: 'GET', headers: {} }, res, reply(open), jest.fn()),
      ).rejects.toThrow('NoSuchKey');
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('should tear the response down and report when the source fails mid-body', async () => {
      const res = fakeResponse();
      const source = new PassThrough();
      const onError = jest.fn();

      await sendMedia(
        { method: 'GET', headers: {} },
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
        { method: 'GET', headers: {} },
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
        { method: 'GET', headers: {} },
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
