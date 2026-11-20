import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  redisPassword: process.env.REDIS_PASSWORD || undefined,
  // Redis key prefix; the test suites use their own (src/test/test-env.ts)
  // so they never see, compete for or obliterate the real worker's jobs.
  prefix: process.env.QUEUE_PREFIX || 'bull',
}));

export interface QueueSettings {
  redisHost: string;
  redisPort: number;
  redisPassword: string | undefined;
  prefix: string;
}

export function bullRootOptions(cfg: QueueSettings): {
  prefix: string;
  connection: { host: string; port: number; password: string | undefined };
} {
  return {
    prefix: cfg.prefix,
    connection: {
      host: cfg.redisHost,
      port: cfg.redisPort,
      password: cfg.redisPassword,
    },
  };
}
