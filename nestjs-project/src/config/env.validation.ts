import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),

  // Object Storage (S3 / MinIO)
  S3_ENDPOINT: Joi.string().uri().default('http://minio:9000'),
  S3_PUBLIC_ENDPOINT: Joi.string().uri().allow('').optional(),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_BUCKET: Joi.string().default('streamtube-media'),
  S3_ACCESS_KEY_ID: Joi.string().required(),
  S3_SECRET_ACCESS_KEY: Joi.string().required(),
  S3_FORCE_PATH_STYLE: Joi.string().valid('true', 'false').default('true'),

  // Message Queue (Redis / BullMQ)
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  QUEUE_PREFIX: Joi.string().default('bull'),

  // Video Upload & Processing
  VIDEO_MAX_SIZE_BYTES: Joi.number().integer().positive().default(10737418240),
  VIDEO_UPLOAD_PART_SIZE_BYTES: Joi.number()
    .integer()
    .min(5242880)
    .max(104857600)
    .default(10485760),
  VIDEO_MAX_OPEN_DRAFTS: Joi.number().integer().positive().default(5),
  VIDEO_DRAFT_TTL_HOURS: Joi.number().integer().positive().default(24),
  VIDEO_PROCESSING_STUCK_MINUTES: Joi.number().integer().positive().default(30),
  // SigV4 presigned URLs are valid for at most 7 days.
  VIDEO_PRESIGNED_URL_EXPIRES_IN: Joi.number()
    .integer()
    .positive()
    .max(604800)
    .default(900),
});
