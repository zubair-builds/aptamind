import { describe, expect, it } from 'vitest';
import { HostBusyError, HostRateLimiter } from './rate-limiter';

describe('HostRateLimiter', () => {
  it('spaces request starts by the minimum interval', async () => {
    const limiter = new HostRateLimiter(4, 60);
    const t0 = Date.now();
    const starts: number[] = [];
    await Promise.all(
      [1, 2, 3].map(async () => {
        const release = await limiter.acquire('h');
        starts.push(Date.now());
        release();
      }),
    );
    // Measured from before the first acquire, so event-loop lag cannot shrink the span.
    expect(Math.max(...starts) - t0).toBeGreaterThanOrEqual(120);
  });

  it('delays new and waiting requests until a cool-down ends', async () => {
    const limiter = new HostRateLimiter(1, 0);
    const holder = await limiter.acquire('h');
    const t0 = Date.now();
    const waiting = limiter.acquire('h').then((r) => {
      r();
      return Date.now() - t0;
    });
    await limiter.coolDown('h', t0 + 150);
    holder();
    expect(await waiting).toBeGreaterThanOrEqual(145);
    // Another host is not affected.
    const other = Date.now();
    (await limiter.acquire('other'))();
    expect(Date.now() - other).toBeLessThan(50);
  });

  it('fails at once with the wait when a cool-down outlasts the deadline (FE-2 D2)', async () => {
    const limiter = new HostRateLimiter(1, 0);
    const holder = await limiter.acquire('h');
    limiter.coolDown('h', Date.now() + 10_000);
    const t0 = Date.now();
    const err = await limiter.acquire('h', { deadlineMs: t0 + 200 }).catch((e: unknown) => e);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(err).toBeInstanceOf(HostBusyError);
    expect((err as HostBusyError).waitMs).toBeGreaterThan(9_800);
    holder();
  });

  it('never shortens a cool-down', async () => {
    const limiter = new HostRateLimiter(1, 0);
    const t0 = Date.now();
    await limiter.coolDown('h', t0 + 120);
    await limiter.coolDown('h', t0 + 10);
    (await limiter.acquire('h'))();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(115);
  });

  it('frees the slot when a wait is aborted', async () => {
    const limiter = new HostRateLimiter(1, 0);
    const holder = await limiter.acquire('h');
    const ac = new AbortController();
    const aborted = limiter.acquire('h', { signal: ac.signal });
    ac.abort(new Error('stop'));
    await expect(aborted).rejects.toThrow('stop');
    holder();
    // The aborted waiter must not hold or swallow the slot.
    const next = await Promise.race([
      limiter.acquire('h'),
      new Promise<null>((r) => setTimeout(() => r(null), 200)),
    ]);
    expect(next).not.toBeNull();
  });

  it('releases the slot when aborted while sleeping for its start time', async () => {
    const limiter = new HostRateLimiter(1, 200);
    (await limiter.acquire('h'))();
    const ac = new AbortController();
    const p = limiter.acquire('h', { signal: ac.signal });
    setTimeout(() => ac.abort(new Error('timeout')), 20);
    await expect(p).rejects.toThrow('timeout');
    // A leaked slot would block this forever (concurrency 1).
    const next = await Promise.race([
      limiter.acquire('h'),
      new Promise<null>((r) => setTimeout(() => r(null), 1_000)),
    ]);
    expect(next).not.toBeNull();
  });
});
