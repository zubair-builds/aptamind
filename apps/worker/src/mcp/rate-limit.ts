/**
 * Token bucket. `refillPerMs` is tokens added per millisecond (60/min → `60 / 60_000`).
 * `now` is injectable so tests can move the clock without waiting.
 */
export class TokenBucketLimiter {
  readonly capacity: number;
  readonly refillPerMs: number;
  private readonly now: () => number;
  private tokens: number;
  private updatedAt: number;

  constructor(opts: { capacity: number; refillPerMs: number; now?: () => number }) {
    if (!Number.isFinite(opts.capacity) || opts.capacity < 0) {
      throw new Error('capacity must be a non-negative finite number');
    }
    if (!Number.isFinite(opts.refillPerMs) || opts.refillPerMs <= 0) {
      throw new Error('refillPerMs must be a positive finite number');
    }
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerMs;
    this.now = opts.now ?? Date.now;
    this.tokens = opts.capacity;
    this.updatedAt = this.now();
  }

  take(): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    this.refill(t);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    const interval = 1 / this.refillPerMs;
    const elapsed = Math.max(0, t - this.updatedAt);
    return { ok: false, retryAfterMs: Math.max(1, Math.ceil(interval - elapsed)) };
  }

  private refill(t: number): void {
    const interval = 1 / this.refillPerMs;
    const elapsed = t - this.updatedAt;
    if (!(elapsed > 0) || !Number.isFinite(interval) || interval <= 0) return;
    const gained = Math.floor(elapsed / interval + 1e-9);
    if (gained <= 0) return;
    if (this.tokens + gained >= this.capacity) {
      this.tokens = this.capacity;
      this.updatedAt = t;
      return;
    }
    this.tokens += gained;
    this.updatedAt += gained * interval;
  }
}

export interface McpLimiters {
  read: TokenBucketLimiter;
  write: TokenBucketLimiter;
  unauth: TokenBucketLimiter;
}

const MINUTE_MS = 60_000;

/** Read tools: 60/min. Write tools (a later change): 10/min. */
export function createMcpLimiters(now?: () => number): McpLimiters {
  return {
    read: new TokenBucketLimiter({ capacity: 60, refillPerMs: 60 / MINUTE_MS, now }),
    write: new TokenBucketLimiter({ capacity: 10, refillPerMs: 10 / MINUTE_MS, now }),
    unauth: new TokenBucketLimiter({ capacity: 10, refillPerMs: 10 / MINUTE_MS, now }),
  };
}
