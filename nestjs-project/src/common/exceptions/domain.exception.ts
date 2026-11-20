export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
    // Extra response headers the HTTP layer must send with the error.
    public readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Channel not found for user');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoAccessDeniedException extends DomainException {
  constructor() {
    super(
      'VIDEO_ACCESS_DENIED',
      403,
      'You do not have permission to access this video',
    );
  }
}

export class VideoInvalidStateException extends DomainException {
  constructor(message = 'Video is not in a valid state for this operation') {
    super('VIDEO_INVALID_STATE', 409, message);
  }
}

export class UploadLimitExceededException extends DomainException {
  constructor(maxBytes: number) {
    super(
      'UPLOAD_LIMIT_EXCEEDED',
      413,
      `Video file size exceeds maximum allowed limit of ${maxBytes} bytes`,
    );
  }
}

export class UnsupportedMediaTypeException extends DomainException {
  constructor(mimeType: string) {
    super(
      'UNSUPPORTED_MEDIA_TYPE',
      415,
      `Unsupported video media type: ${mimeType}`,
    );
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor(message = 'Invalid or incomplete multipart upload parts') {
    super('INVALID_UPLOAD_PARTS', 400, message);
  }
}

export class InvalidRangeException extends DomainException {
  constructor(
    totalSize?: number,
    message = 'Requested byte range is invalid or unsatisfiable',
  ) {
    // RFC 9110 §15.5.17: a 416 carries the current length of the resource.
    super(
      'INVALID_RANGE',
      416,
      message,
      totalSize !== undefined
        ? { 'Content-Range': `bytes */${totalSize}` }
        : undefined,
    );
  }
}
