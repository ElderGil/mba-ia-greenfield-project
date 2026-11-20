import queueConfig, { bullRootOptions } from './queue.config';

describe('queueConfig', () => {
  const original = process.env.QUEUE_PREFIX;

  afterEach(() => {
    if (original === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = original;
  });

  it('should default the BullMQ prefix to bull, the value the worker uses', () => {
    delete process.env.QUEUE_PREFIX;

    expect(queueConfig().prefix).toBe('bull');
  });

  it('should take the prefix from QUEUE_PREFIX', () => {
    process.env.QUEUE_PREFIX = 'other';

    expect(queueConfig().prefix).toBe('other');
  });

  it('should pass prefix and connection to BullModule', () => {
    expect(
      bullRootOptions({
        redisHost: 'redis',
        redisPort: 6379,
        redisPassword: undefined,
        prefix: 'p',
      }),
    ).toEqual({
      prefix: 'p',
      connection: { host: 'redis', port: 6379, password: undefined },
    });
  });
});
