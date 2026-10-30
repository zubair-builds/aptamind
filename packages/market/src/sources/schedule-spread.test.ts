import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_BACKOFF_MS, backoffUntil, sourceBackoffMs, spreadCron } from './schedule-spread';

describe('spreadCron', () => {
  it('is stable for one source id', () => {
    expect(spreadCron('src_abc', 360)).toBe(spreadCron('src_abc', 360));
  });

  it('builds a cron for whole-hour intervals that divide a day', () => {
    expect(spreadCron('src_abc', 360)).toMatch(/^\d{1,2} [0-5]-23\/6 \* \* \*$/);
    expect(spreadCron('src_abc', 60)).toMatch(/^\d{1,2} \* \* \* \*$/);
    expect(spreadCron('src_abc', 1440)).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    expect(spreadCron('src_abc', 15)).toMatch(/^\d{1,2}-59\/15 \* \* \* \*$/);
  });

  it('keeps the minute and hour offsets in range', () => {
    for (let i = 0; i < 200; i += 1) {
      const [m, h] = spreadCron(randomUUID(), 360)!.split(' ');
      expect(Number(m)).toBeGreaterThanOrEqual(0);
      expect(Number(m)).toBeLessThan(60);
      expect(Number(h!.split('-')[0])).toBeLessThan(6);
    }
  });

  it('returns null for intervals a cron cannot express evenly', () => {
    expect(spreadCron('src_abc', 7)).toBeNull();
    expect(spreadCron('src_abc', 300)).toBeNull();
    expect(spreadCron('src_abc', 0)).toBeNull();
  });

  it('spreads 1,000 ids nearly evenly across the minutes', () => {
    const counts = new Array<number>(60).fill(0);
    const hours = new Array<number>(6).fill(0);
    for (let i = 0; i < 1000; i += 1) {
      const [m, h] = spreadCron(`src_${randomUUID()}`, 360)!.split(' ');
      counts[Number(m)]! += 1;
      hours[Number(h!.split('-')[0])]! += 1;
    }
    // Expected about 16.7 per minute. A chi-square over 59 degrees of freedom above 120 is
    // vanishingly unlikely for a uniform hash.
    const expected = 1000 / 60;
    const chi = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
    expect(chi).toBeLessThan(120);
    expect(Math.max(...counts)).toBeLessThan(45);
    for (const h of hours) expect(h).toBeGreaterThan(100);
  });
});

describe('sourceBackoffMs', () => {
  const hour = 3_600_000;
  it('doubles the interval per consecutive failure', () => {
    expect(sourceBackoffMs(360, 1)).toBe(12 * hour);
    expect(sourceBackoffMs(60, 1)).toBe(2 * hour);
    expect(sourceBackoffMs(60, 2)).toBe(4 * hour);
    expect(sourceBackoffMs(60, 3)).toBe(8 * hour);
  });

  it('caps at 24 hours', () => {
    expect(sourceBackoffMs(360, 2)).toBe(MAX_BACKOFF_MS);
    expect(sourceBackoffMs(60, 40)).toBe(MAX_BACKOFF_MS);
    expect(sourceBackoffMs(60, 5000)).toBe(MAX_BACKOFF_MS);
  });

  it('has no backoff without a failure', () => {
    expect(sourceBackoffMs(360, 0)).toBe(0);
  });

  it('uses Retry-After when it is longer', () => {
    const base = new Date('2026-10-01T00:00:00Z');
    expect(backoffUntil({ base, failedAt: base, intervalMinutes: 60, failures: 1 })).toEqual(
      new Date(base.getTime() + 2 * hour),
    );
    expect(
      backoffUntil({ base, failedAt: base, intervalMinutes: 60, failures: 1, retryAfterMs: 5 * hour }),
    ).toEqual(new Date(base.getTime() + 5 * hour));
    expect(
      backoffUntil({ base, failedAt: base, intervalMinutes: 60, failures: 1, retryAfterMs: 60_000 }),
    ).toEqual(new Date(base.getTime() + 2 * hour));
  });
});
