import { generateShortCode, SHORT_CODE_LENGTH } from './short-code.util';

describe('generateShortCode', () => {
  it('generates an 11-character URL-safe base64url string', () => {
    const code = generateShortCode();
    expect(code).toHaveLength(SHORT_CODE_LENGTH);
    expect(code).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('generates distinct codes across consecutive calls', () => {
    const codes = new Set(
      Array.from({ length: 100 }, () => generateShortCode()),
    );
    expect(codes.size).toBe(100);
  });
});
