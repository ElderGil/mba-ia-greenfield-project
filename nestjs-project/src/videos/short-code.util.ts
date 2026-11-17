import { randomBytes } from 'node:crypto';

export const SHORT_CODE_LENGTH = 11;

export function generateShortCode(): string {
  // 8 random bytes encoded as base64url yield exactly 11 URL-safe chars (~64 bits entropy).
  return randomBytes(8).toString('base64url');
}
