import { afterEach, describe, expect, it, vi } from 'vitest';
import { pingWithTimeout, READY_CHECK_TIMEOUT_MS, runReadyChecks } from './ready-checks';

afterEach(() => {
  vi.useRealTimers();
});

const hang = () => new Promise<boolean>(() => {});

describe('pingWithTimeout', () => {
  it('returns a timely true without waiting for the timeout', async () => {
    vi.useFakeTimers();
    const result = pingWithTimeout(Promise.resolve(true), READY_CHECK_TIMEOUT_MS);
    await expect(result).resolves.toBe(true);
  });

  it('returns a timely false without waiting for the timeout', async () => {
    vi.useFakeTimers();
    await expect(pingWithTimeout(Promise.resolve(false), 1_500)).resolves.toBe(false);
  });

  it('returns false when the ping rejects', async () => {
    vi.useFakeTimers();
    await expect(pingWithTimeout(Promise.reject(new Error('down')), 1_500)).resolves.toBe(false);
  });

  it('returns false once the timeout elapses on a hanging ping', async () => {
    vi.useFakeTimers();
    const result = pingWithTimeout(hang(), READY_CHECK_TIMEOUT_MS);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(READY_CHECK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
    expect(settled).toBe(true);
  });

  it('does not emit an unhandled rejection when a timed-out ping later rejects', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      errors.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let rejectPing: (err: Error) => void = () => {};
      const ping = new Promise<boolean>((_, reject) => {
        rejectPing = reject;
      });
      const result = pingWithTimeout(ping, READY_CHECK_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(READY_CHECK_TIMEOUT_MS);
      await expect(result).resolves.toBe(false);
      vi.useRealTimers();
      rejectPing(new Error('late failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(errors).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('runReadyChecks', () => {
  it('returns all true when every ping succeeds promptly', async () => {
    vi.useFakeTimers();
    await expect(
      runReadyChecks({
        mongo: () => Promise.resolve(true),
        redis: () => Promise.resolve(true),
        objectStorage: () => Promise.resolve(true),
      }),
    ).resolves.toEqual({ mongo: true, redis: true, objectStorage: true });
  });

  it('returns false for a hung ping and true for the rest (mixed)', async () => {
    vi.useFakeTimers();
    const result = runReadyChecks({
      mongo: () => Promise.resolve(true),
      redis: hang,
      objectStorage: () => Promise.resolve(true),
    });
    await vi.advanceTimersByTimeAsync(READY_CHECK_TIMEOUT_MS);
    await expect(result).resolves.toEqual({ mongo: true, redis: false, objectStorage: true });
  });

  it('returns false when a ping factory throws synchronously', async () => {
    await expect(
      runReadyChecks({
        mongo: () => {
          throw new Error('boom');
        },
        redis: () => Promise.resolve(true),
        objectStorage: () => Promise.resolve(true),
      }),
    ).resolves.toEqual({ mongo: false, redis: true, objectStorage: true });
  });
});
