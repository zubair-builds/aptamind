import { createHash } from 'node:crypto';

/** Hours that divide a day evenly, so a `h0-23/h` cron fires at a constant interval. */
const DAY_DIVISORS = new Set([1, 2, 3, 4, 6, 8, 12, 24]);
/** Minutes that divide an hour evenly. */
const HOUR_DIVISORS = new Set([1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30]);

export const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

/**
 * The retry policy of the job board fetch node (`market.ats.refresh`). The fetch reads it to know
 * its last attempt: only a run that failed for good backs the source off (H2).
 */
export const FETCH_RETRY = { maxAttempts: 4, backoffMs: 5_000 } as const;

function hashOf(sourceId: string): number {
  return createHash('sha256').update(sourceId).digest().readUInt32BE(0);
}

/**
 * A cron with the same interval as `intervalMinutes`, offset by a hash of the source id.
 * Interval schedules all fire on the hour after a deploy; a stable offset per source spreads
 * the load on each provider across the interval. `null` when no even cron exists.
 */
export function spreadCron(sourceId: string, intervalMinutes: number): string | null {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) return null;
  const n = hashOf(sourceId);
  const minute = n % 60;
  if (intervalMinutes < 60) {
    if (!HOUR_DIVISORS.has(intervalMinutes)) return null;
    if (intervalMinutes === 1) return '* * * * *';
    return `${n % intervalMinutes}-59/${intervalMinutes} * * * *`;
  }
  if (intervalMinutes % 60 !== 0) return null;
  const hours = intervalMinutes / 60;
  if (!DAY_DIVISORS.has(hours)) return null;
  if (hours === 1) return `${minute} * * * *`;
  const offset = Math.floor(n / 60) % hours;
  if (hours === 24) return `${minute} ${offset} * * *`;
  return `${minute} ${offset}-23/${hours} * * *`;
}

/** Interval × 2 per consecutive failure, capped at 24 hours; 0 without a failure. */
export function sourceBackoffMs(intervalMinutes: number, failures: number): number {
  if (failures <= 0) return 0;
  // 2^failures overflows to Infinity for large streaks; min() keeps the cap exact.
  const raw = intervalMinutes * 60_000 * 2 ** Math.min(failures, 32);
  return Math.min(MAX_BACKOFF_MS, raw);
}

/**
 * When the next scheduled fire may run. `base` is the slot that failed (the scheduled time,
 * or the failure time for a manual run). A provider's Retry-After wins when it is longer.
 */
export function backoffUntil(input: {
  base: Date;
  failedAt: Date;
  intervalMinutes: number;
  failures: number;
  retryAfterMs?: number;
}): Date {
  const computed = input.base.getTime() + sourceBackoffMs(input.intervalMinutes, input.failures);
  const retryAfter = input.failedAt.getTime() + Math.max(0, input.retryAfterMs ?? 0);
  return new Date(Math.max(computed, retryAfter));
}
