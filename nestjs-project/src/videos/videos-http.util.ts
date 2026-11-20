import { pipeline, type Readable } from 'node:stream';
import type { Request, Response } from 'express';

export interface OpenedMedia {
  stream: Readable;
  contentLength?: number;
}

export interface MediaReply {
  status: number;
  headers: Record<string, string>;
  open: () => Promise<OpenedMedia>;
  // Strong validator; ready media never changes, so it can be revalidated.
  etag?: string;
}

const FALLBACK_FILENAME = 'video.mp4';

// RFC 5987 attr-char: encodeURIComponent leaves ' ( ) * unescaped.
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * RFC 6266 attachment header. Node rejects header values outside Latin-1,
 * so the quoted `filename` carries an ASCII fallback and `filename*` the
 * UTF-8 original.
 */
export function buildContentDisposition(filename: string): string {
  const base = (filename.split(/[/\\]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim();
  const name = base.length > 0 ? base : FALLBACK_FILENAME;
  const ascii = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/gu, '_')
    .replace(/\\/g, '_');

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

const BYTES_UNIT = 'bytes=';

/**
 * The Range header to honour, or undefined when the full representation
 * must be sent. Decided before the range is parsed (RFC 9110):
 * - range handling is defined for GET only, so HEAD ignores Range (§14.2);
 * - a matching If-None-Match ends in 304, never in 206/416 (§13.2.2);
 * - If-Range must be a strong match for the current ETag; anything else,
 *   an HTTP-date included (no Last-Modified is sent), asks for the full
 *   representation (§13.1.5);
 * - an unknown range unit is ignored (§14.2), and so are several ranges,
 *   which this endpoint does not serve (multipart/byteranges).
 * A malformed or unsatisfiable byte range is left to the parser (416).
 */
export function selectRange(
  req: Pick<Request, 'method' | 'headers'>,
  etag: string,
): string | undefined {
  const range = req.headers.range?.trim();
  if (!range || req.method !== 'GET') return undefined;
  if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) return undefined;

  const ifRange = req.headers['if-range'];
  if (ifRange !== undefined && String(ifRange).trim() !== etag) {
    return undefined;
  }

  // Range units are case-insensitive.
  if (!range.toLowerCase().startsWith(BYTES_UNIT) || range.includes(',')) {
    return undefined;
  }
  return BYTES_UNIT + range.slice(BYTES_UNIT.length);
}

/**
 * Sends a media body without buffering it.
 *
 * - A matching If-None-Match gets 304 without touching storage.
 * - HEAD gets the headers only; the storage object is never opened.
 * - Headers are written only after the source opened, so a storage error
 *   still reaches the exception filter as a normal JSON error.
 * - A client that leaves while the source is opening gets the source
 *   destroyed instead of leaking the storage connection.
 * - pipeline() tears down both sides when either one fails mid-body.
 */
export async function sendMedia(
  req: Pick<Request, 'method' | 'headers'>,
  res: Response,
  reply: MediaReply,
  onSourceError: (err: Error) => void,
): Promise<void> {
  const headers = reply.etag
    ? { ...reply.headers, ETag: reply.etag, 'Cache-Control': 'no-cache' }
    : reply.headers;

  if (
    reply.etag &&
    matchesIfNoneMatch(req.headers['if-none-match'], reply.etag)
  ) {
    res.status(304);
    res.setHeader('ETag', reply.etag);
    res.setHeader('Cache-Control', 'no-cache');
    res.end();
    return;
  }

  if (req.method === 'HEAD') {
    res.status(reply.status);
    setHeaders(res, headers);
    res.end();
    return;
  }

  let clientGone = false;
  const markGone = (): void => {
    clientGone = true;
  };
  res.once('close', markGone);

  let opened: OpenedMedia;
  try {
    opened = await reply.open();
  } finally {
    res.off('close', markGone);
  }

  if (clientGone) {
    opened.stream.destroy();
    return;
  }

  res.status(reply.status);
  setHeaders(res, headers);
  if (
    reply.headers['Content-Length'] === undefined &&
    opened.contentLength !== undefined
  ) {
    res.setHeader('Content-Length', String(opened.contentLength));
  }

  pipeline(opened.stream, res, (err) => {
    // A client closing the connection is normal (seek, tab closed).
    if (err && !clientClosed(res, err)) onSourceError(err);
  });
}

// RFC 9110 §13.1.2: weak comparison, list of tags or "*".
function matchesIfNoneMatch(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  if (!header) return false;
  const opaque = (tag: string): string => tag.trim().replace(/^W\//, '');
  const wanted = opaque(etag);
  return String(header)
    .split(',')
    .some((tag) => tag.trim() === '*' || opaque(tag) === wanted);
}

function setHeaders(res: Response, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

function clientClosed(res: Response, err: NodeJS.ErrnoException): boolean {
  return (
    err.code === 'ERR_STREAM_PREMATURE_CLOSE' &&
    res.destroyed &&
    !res.writableFinished
  );
}
