import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from './api';
import type { Readiness } from './types';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ apiRequest, API_BASE_URL: 'http://api.test' }));
const { describeHealth, fetchApiHealth, HEALTH_PROBE_TIMEOUTS_MS, HEALTH_RETRY_DELAY_MS, toApiHealth } =
  await import('./health');
type ApiHealth = Parameters<typeof describeHealth>[0];

const ready: ApiResult<Readiness> = {
  ok: true,
  status: 200,
  data: { status: 'ready', checks: { mongo: true, redis: true, objectStorage: true } },
};
const notReady = (checks: Record<string, boolean>): ApiResult<Readiness> => ({
  ok: false,
  error: {
    kind: 'http',
    status: 503,
    code: 'http_503',
    message: 'not ready',
    details: { status: 'not_ready', checks },
    method: 'GET',
    path: '/ready',
  },
});
const unavailable: ApiResult<Readiness> = {
  ok: false,
  error: {
    kind: 'unavailable',
    status: null,
    code: 'api_unavailable',
    message: 'x',
    method: 'GET',
    path: '/ready',
  },
};
const h = (state: ApiHealth['state'], checks: ApiHealth['checks'] = null): ApiHealth => ({
  state,
  url: 'http://api.test',
  checks,
});

afterEach(() => {
  apiRequest.mockReset();
  vi.useRealTimers();
});

async function probe() {
  vi.useFakeTimers();
  const pending = fetchApiHealth();
  await vi.runAllTimersAsync();
  return pending;
}

describe('fetchApiHealth', () => {
  it('asks once when the first probe is ready', async () => {
    apiRequest.mockResolvedValue(ready);
    expect((await probe()).state).toBe('ready');
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest).toHaveBeenCalledWith('/ready', { timeoutMs: HEALTH_PROBE_TIMEOUTS_MS[0] });
  });

  it('retries once, so a brief blip never reaches the notice', async () => {
    apiRequest.mockResolvedValueOnce(notReady({ mongo: false })).mockResolvedValueOnce(ready);
    expect((await probe()).state).toBe('ready');
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(apiRequest).toHaveBeenLastCalledWith('/ready', { timeoutMs: HEALTH_PROBE_TIMEOUTS_MS[1] });
  });

  it('reports not_ready with the failing checks after two failures', async () => {
    apiRequest.mockResolvedValue(notReady({ mongo: false, redis: true }));
    const health = await probe();
    expect(health.state).toBe('not_ready');
    expect(health.checks).toEqual({ mongo: false, redis: true });
  });

  it('reports unavailable when the API cannot answer twice', async () => {
    apiRequest.mockResolvedValue(unavailable);
    expect((await probe()).state).toBe('unavailable');
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('keeps the first not_ready when the 700ms retry aborts (FE-9 hang)', async () => {
    const checks = { mongo: true, redis: false, objectStorage: true };
    apiRequest.mockResolvedValueOnce(notReady(checks)).mockResolvedValueOnce(unavailable);
    const health = await probe();
    expect(health.state).toBe('not_ready');
    expect(health.checks).toEqual(checks);
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('stays within the readiness budget of 3 s', () => {
    expect(
      HEALTH_PROBE_TIMEOUTS_MS[0] + HEALTH_PROBE_TIMEOUTS_MS[1] + HEALTH_RETRY_DELAY_MS,
    ).toBeLessThanOrEqual(3000);
  });

  it('maps answers without the network (pure)', () => {
    expect(toApiHealth(ready).state).toBe('ready');
    expect(toApiHealth(unavailable)).toMatchObject({ state: 'unavailable', checks: null });
  });
});

describe('describeHealth', () => {
  it('says nothing while ready', () => {
    expect(describeHealth(h('ready'))).toBeNull();
  });

  it('explains a database outage in plain words', () => {
    const d = describeHealth(h('not_ready', { mongo: false, redis: true, objectStorage: true }))!;
    expect(d.headline).toBe('Data is temporarily unavailable.');
    expect(d.detail).toContain("The database isn't responding");
    expect(d.detail).toContain('Retrying automatically.');
    expect(d.signature).toBe('not_ready:mongo');
    expect(d.failed).toEqual(['mongo']);
  });

  it('tailors the copy for Redis and object storage alone', () => {
    expect(describeHealth(h('not_ready', { mongo: true, redis: false }))!.headline).toBe(
      'Background jobs are paused.',
    );
    const storage = describeHealth(h('not_ready', { mongo: true, objectStorage: false }))!;
    expect(storage.headline).toBe("Snapshots and imports can't be opened right now.");
    expect(storage.detail).toContain('Everything else still works.');
  });

  it('leads with the most severe failure and lists the others', () => {
    const d = describeHealth(h('not_ready', { redis: false, objectStorage: false, mongo: false }))!;
    expect(d.headline).toBe('Data is temporarily unavailable.');
    expect(d.detail).toContain('Also affected: background jobs, file storage.');
    expect(d.signature).toBe('not_ready:mongo,objectStorage,redis');
  });

  it('covers an unreachable API and unknown checks', () => {
    const down = describeHealth(h('unavailable'))!;
    expect(down.headline).toBe('Data is temporarily unavailable.');
    expect(down.signature).toBe('unavailable:');
    expect(down.devHints[0]).toContain('restart the dev server');
    const odd = describeHealth(h('not_ready', { search: false }))!;
    expect(odd.headline).toBe('Some data is temporarily unavailable.');
    expect(odd.devHints).toEqual([]);
    expect(describeHealth(h('not_ready', null))!.headline).toBe('Some data is temporarily unavailable.');
  });

  it('names env vars in dev hints but never prints a URL or value', () => {
    const d = describeHealth(h('not_ready', { mongo: false, redis: false, objectStorage: false }))!;
    const hints = d.devHints.join('\n');
    for (const name of ['MONGODB_URI', 'REDIS_URL', 'S3_ENDPOINT']) expect(hints).toContain(name);
    expect(hints).not.toContain('://');
    expect(describeHealth(h('unavailable'))!.devHints.join('')).not.toContain('://');
  });
});
