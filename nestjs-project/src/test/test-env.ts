import { testBucketName, testDatabaseName } from './test-database';

// Loaded by Jest (setupFiles) after dotenv, before any test module reads the
// config. Tests never share state with the running stack:
// - their own database and bucket (`streamtube_test`, `streamtube-media-test`),
//   created and migrated by global-setup.ts;
// - their own BullMQ prefix, so the compose video-worker never picks up test
//   jobs and queue.obliterate() never wipes real ones.
process.env.DB_NAME = testDatabaseName(process.env.DB_NAME || 'streamtube');
process.env.S3_BUCKET = testBucketName(
  process.env.S3_BUCKET || 'streamtube-media',
);
process.env.QUEUE_PREFIX = 'streamtube-test';
