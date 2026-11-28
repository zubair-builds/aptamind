import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { READY_CHECK_TIMEOUT_MS, runReadyChecks, type Platform } from '@aptamind/platform';
import { healthRoutes } from './health';

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /ready', () => {
  it('returns 200 when every check is up', async () => {
    const app = Fastify();
    await healthRoutes(app, {
      platform: {
        checks: () =>
          runReadyChecks({
            mongo: () => Promise.resolve(true),
            redis: () => Promise.resolve(true),
            objectStorage: () => Promise.resolve(true),
          }),
      } as unknown as Platform,
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ready',
      checks: { mongo: true, redis: true, objectStorage: true },
    });
    await app.close();
  });

  it('returns 503 within the check bound when a dependency ping hangs', async () => {
    vi.useFakeTimers();
    const app = Fastify();
    await healthRoutes(app, {
      platform: {
        checks: () =>
          runReadyChecks({
            mongo: () => new Promise(() => {}),
            redis: () => Promise.resolve(true),
            objectStorage: () => Promise.resolve(true),
          }),
      } as unknown as Platform,
    });
    const pending = app.inject({ method: 'GET', url: '/ready' });
    await vi.advanceTimersByTimeAsync(READY_CHECK_TIMEOUT_MS);
    const res = await pending;
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'not_ready',
      checks: { mongo: false, redis: true, objectStorage: true },
    });
    vi.useRealTimers();
    await app.close();
  });
});
