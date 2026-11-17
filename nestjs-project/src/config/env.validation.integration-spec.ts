import type * as Joi from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY_ID: 'minioadmin',
  S3_SECRET_ACCESS_KEY: 'minioadmin',
};

interface EnvValidationOutput {
  error?: Joi.ValidationError;
  value: Record<string, unknown>;
}

const validate = (env: Record<string, string>): EnvValidationOutput => {
  const result = envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as { error?: Joi.ValidationError; value: unknown };
  return {
    error: result.error,
    value: result.value as Record<string, unknown>,
  };
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — Phase 03 Storage, Queue & Video', () => {
  it('should require S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY', () => {
    const { error } = envValidationSchema.validate(
      {
        DB_USERNAME: 'user',
        DB_PASSWORD: 'pass',
        DB_NAME: 'db',
        JWT_SECRET: 'secret',
        JWT_REFRESH_SECRET: 'refresh-secret',
      },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY_ID');
    expect(error!.message).toContain('S3_SECRET_ACCESS_KEY');
  });

  it('should apply Docker service defaults for minio, redis, and video limits', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
    expect(value.S3_BUCKET).toBe('streamtube-media');
    expect(value.S3_FORCE_PATH_STYLE).toBe('true');
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.VIDEO_MAX_SIZE_BYTES).toBe(10737418240);
    expect(value.VIDEO_UPLOAD_PART_SIZE_BYTES).toBe(10485760);
  });

  it('should reject VIDEO_UPLOAD_PART_SIZE_BYTES below 5 MiB S3 minimum', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '1048576' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });
});
