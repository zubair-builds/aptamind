import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * True when `header` is `Bearer <token>`. Both sides are hashed before compare so a length
 * mismatch never throws and the check does not leak the token through timing.
 */
export function checkBearer(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  return timingSafeEqual(sha256(presented), sha256(token));
}
