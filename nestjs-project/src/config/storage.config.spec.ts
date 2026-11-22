import storageConfig from './storage.config';

describe('storageConfig', () => {
  const saved = {
    id: process.env.S3_ACCESS_KEY_ID,
    secret: process.env.S3_SECRET_ACCESS_KEY,
  };

  afterEach(() => {
    if (saved.id === undefined) delete process.env.S3_ACCESS_KEY_ID;
    else process.env.S3_ACCESS_KEY_ID = saved.id;
    if (saved.secret === undefined) delete process.env.S3_SECRET_ACCESS_KEY;
    else process.env.S3_SECRET_ACCESS_KEY = saved.secret;
  });

  it('should not fall back to well-known credentials when none are set', () => {
    // The env schema requires them; a silent minioadmin default would hide
    // a missing secret wherever the schema does not run.
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;

    const cfg = storageConfig();

    expect(cfg.accessKeyId).toBe('');
    expect(cfg.secretAccessKey).toBe('');
  });
});
