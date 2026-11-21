import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => {
  const endpoint = process.env.S3_ENDPOINT || 'http://minio:9000';
  const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT || endpoint;

  return {
    endpoint,
    publicEndpoint,
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || 'streamtube-media',
    // Required by the env schema: no well-known fallback (see .env.example).
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  };
});
