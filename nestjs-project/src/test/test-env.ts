// Loaded by Jest (setupFiles) after dotenv. Tests always run on their own
// BullMQ prefix: the compose video-worker must not pick up test jobs, and
// queue.obliterate() in the suites must not wipe real ones.
process.env.QUEUE_PREFIX = 'streamtube-test';
