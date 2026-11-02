import { describe, expect, it } from 'vitest';
import { TokenBucketLimiter, createMcpLimiters } from './rate-limit';

describe('TokenBucketLimiter', () => {
  it('denies the 61st read and refills one token per second', () => {
    let now = 0;
    const { read } = createMcpLimiters(() => now);
    for (let i = 0; i < 60; i++) expect(read.take()).toEqual({ ok: true });
    expect(read.take()).toEqual({ ok: false, retryAfterMs: 1000 });
    now = 999;
    expect(read.take().ok).toBe(false);
    now = 1000;
    expect(read.take()).toEqual({ ok: true });
  });

  it('denies the 11th write and refills on its own clock', () => {
    let now = 0;
    const { write } = createMcpLimiters(() => now);
    for (let i = 0; i < 10; i++) expect(write.take()).toEqual({ ok: true });
    expect(write.take()).toEqual({ ok: false, retryAfterMs: 6000 });
    now = 6000;
    expect(write.take()).toEqual({ ok: true });
  });

  it('caps a burst at capacity after the clock jumps', () => {
    let now = 0;
    const bucket = new TokenBucketLimiter({ capacity: 2, refillPerMs: 1 / 1000, now: () => now });
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take()).toEqual({ ok: false, retryAfterMs: 1000 });
    now = 100_000;
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(false);
  });
});
