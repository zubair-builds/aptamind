import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError, SafeHttpClient } from './http-client';
import { HostRateLimiter, type HostLimiter } from './rate-limiter';
import { DEFAULT_RETRY_AFTER_CAP_MS, parseRetryAfter } from './retry-after';

const NOW = Date.parse('2026-10-01T12:00:00Z');

describe('parseRetryAfter', () => {
  it('reads delay-seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
    expect(parseRetryAfter(' 0 ', NOW)).toBe(0);
  });

  it('reads the three HTTP-date forms as GMT', () => {
    expect(parseRetryAfter('Thu, 01 Oct 2026 12:00:30 GMT', NOW)).toBe(30_000);
    expect(parseRetryAfter('Thursday, 01-Oct-26 12:01:00 GMT', NOW)).toBe(60_000);
    expect(parseRetryAfter('Thu Oct  1 12:00:05 2026', NOW)).toBe(5_000);
  });

  it('gives 0 for a date in the past', () => {
    expect(parseRetryAfter('Thu, 01 Oct 2026 11:00:00 GMT', NOW)).toBe(0);
  });

  it('takes the longest valid value of repeated headers (FE-2 D4)', () => {
    expect(parseRetryAfter('120, 60', NOW)).toBe(120_000);
    expect(parseRetryAfter('10, Thu, 01 Oct 2026 12:00:30 GMT', NOW)).toBe(30_000);
    expect(parseRetryAfter('Thu, 01 Oct 2026 12:00:30 GMT, 90', NOW)).toBe(90_000);
    expect(parseRetryAfter('soon, 5', NOW)).toBe(5_000);
    expect(parseRetryAfter('soon, later', NOW)).toBeUndefined();
  });

  it('caps long delays', () => {
    expect(parseRetryAfter('999999999999', NOW)).toBe(DEFAULT_RETRY_AFTER_CAP_MS);
    expect(parseRetryAfter('Fri, 01 Oct 2027 12:00:00 GMT', NOW)).toBe(DEFAULT_RETRY_AFTER_CAP_MS);
    expect(parseRetryAfter('600', NOW, 60_000)).toBe(60_000);
  });

  it.each([
    undefined,
    null,
    '',
    '   ',
    '-5',
    '1.5',
    '5.5',
    '1e3',
    'soon',
    '120s',
    'Thu, 32 Oct 2026 25:00:00 GMT',
  ])('rejects %j', (v) => {
    expect(parseRetryAfter(v, NOW)).toBeUndefined();
  });
});

describe('SafeHttpClient Retry-After', () => {
  let server: Server;
  let base: string;
  const coolDowns: Array<{ host: string; until: number }> = [];
  const limiter: HostLimiter = {
    acquire: async () => () => {},
    coolDown: (host, until) => {
      coolDowns.push({ host, until });
    },
  };
  const client = new SafeHttpClient({
    allowPrivateNetwork: true,
    userAgent: 'test',
    defaultTimeoutMs: 5_000,
    maxResponseBytes: 1024,
    perHostConcurrency: 1,
    perHostMinIntervalMs: 0,
    limiter,
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const [, status, retryAfter] = (req.url ?? '').split('/');
      if (retryAfter) res.setHeader('retry-after', decodeURIComponent(retryAfter));
      res.statusCode = Number(status);
      res.end('x');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await client.close();
    await new Promise((r) => server.close(r));
  });

  it('exposes Retry-After on 429 and 503 and cools the host down', async () => {
    coolDowns.length = 0;
    const before = Date.now();
    const res = await client.request({ url: `${base}/429/30` });
    expect(res.retryAfterMs).toBe(30_000);
    const res503 = await client.request({ url: `${base}/503/7200` });
    expect(res503.retryAfterMs).toBe(DEFAULT_RETRY_AFTER_CAP_MS);
    expect(coolDowns).toHaveLength(2);
    expect(coolDowns[0]?.host).toBe(new URL(base).host);
    expect(coolDowns[0]?.until).toBeGreaterThanOrEqual(before + 30_000);
    expect(coolDowns[0]?.until).toBeLessThan(Date.now() + 30_001);
  });

  it('puts retryAfterMs on the HttpError from getOk', async () => {
    const err = await client.getOk({ url: `${base}/429/5` }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).retryAfterMs).toBe(5_000);
    expect((err as HttpError).retryable).toBe(true);
  });

  it('does not wait for a stalled cool-down write (FE-2 D1)', async () => {
    const stalled = new SafeHttpClient({
      allowPrivateNetwork: true,
      userAgent: 'test',
      defaultTimeoutMs: 5_000,
      maxResponseBytes: 1024,
      perHostConcurrency: 1,
      perHostMinIntervalMs: 0,
      limiter: { acquire: async () => () => {}, coolDown: () => new Promise<void>(() => {}) },
    });
    const res = await Promise.race([
      stalled.request({ url: `${base}/429/30` }),
      new Promise<null>((r) => setTimeout(() => r(null), 1_000)),
    ]);
    await stalled.close();
    expect(res?.retryAfterMs).toBe(30_000);
  });

  it('fails at once with retryAfterMs when the cool-down outlasts the timeout (FE-2 D2)', async () => {
    const real = new SafeHttpClient({
      allowPrivateNetwork: true,
      userAgent: 'test',
      defaultTimeoutMs: 5_000,
      maxResponseBytes: 1024,
      perHostConcurrency: 1,
      perHostMinIntervalMs: 0,
      limiter: new HostRateLimiter(1, 0),
    });
    await real.request({ url: `${base}/429/3600` });
    const t0 = Date.now();
    const err = await real.request({ url: `${base}/200`, timeoutMs: 500 }).catch((e: unknown) => e);
    await real.close();
    expect(Date.now() - t0).toBeLessThan(200);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).retryable).toBe(true);
    expect((err as HttpError).retryAfterMs).toBeGreaterThan(3_590_000);
  });

  it('ignores Retry-After on other statuses and bad values', async () => {
    coolDowns.length = 0;
    expect((await client.request({ url: `${base}/500/30` })).retryAfterMs).toBeUndefined();
    expect((await client.request({ url: `${base}/429/soon` })).retryAfterMs).toBeUndefined();
    expect((await client.request({ url: `${base}/429/0` })).retryAfterMs).toBe(0);
    expect(coolDowns).toHaveLength(0);
  });
});
