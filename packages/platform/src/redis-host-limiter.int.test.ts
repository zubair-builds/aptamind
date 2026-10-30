import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@aptamind/config';
import {
  HostBusyError,
  RedisHostRateLimiter,
  SafeHttpClient,
  type RedisHostRateLimiterOptions,
} from '@aptamind/net';
import { createRedisConnection } from '@aptamind/queue';

// FE-2: two limiter instances on two Redis connections stand in for two worker processes.
const cfg = loadConfig({ ...process.env, NODE_ENV: 'test' });
const prefix = `t-fe2-${randomBytes(4).toString('hex')}:`;
const redisA = createRedisConnection(cfg.redis.url);
const redisB = createRedisConnection(cfg.redis.url);
const errors: unknown[] = [];

function limiter(redis: typeof redisA, over: Partial<RedisHostRateLimiterOptions> = {}) {
  return new RedisHostRateLimiter({
    redis,
    keyPrefix: prefix,
    maxConcurrent: 1,
    minIntervalMs: 0,
    leaseTtlMs: 60_000,
    onError: (err) => errors.push(err),
    ...over,
  });
}
// Hash-tagged so all of a host's keys share one Redis Cluster slot (FE-2 D5).
const leases = (host: string) => redisA.zcard(`${prefix}net:host:{${host}}:leases`);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
  const keys = await redisA.keys(`${prefix}*`);
  if (keys.length) await redisA.del(...keys);
  redisA.disconnect();
  redisB.disconnect();
  expect(errors).toEqual([]);
});

describe('RedisHostRateLimiter (shared budget)', () => {
  it('holds concurrency and spacing across two instances', async () => {
    const opts = { maxConcurrent: 2, minIntervalMs: 60 };
    const [a, b] = [limiter(redisA, opts), limiter(redisB, opts)];
    let active = 0;
    let maxActive = 0;
    const starts: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const release = await (i % 2 ? a : b).acquire('share.test');
        starts.push(Date.now());
        maxActive = Math.max(maxActive, ++active);
        await delay(150);
        active -= 1;
        release();
      }),
    );
    starts.sort((x, y) => x - y);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
    expect(starts).toHaveLength(10);
    expect(maxActive).toBe(2);
    // Grants are spaced on Redis TIME; local timestamps add a little reply and event-loop lag.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(45);
    expect(starts[9]! - t0).toBeGreaterThanOrEqual(9 * 60);
    await delay(50);
    expect(await leases('share.test')).toBe(0);
  });

  it('reclaims the lease of a holder that never releases', async () => {
    const crashed = limiter(redisA, { leaseTtlMs: 400 });
    await crashed.acquire('crash.test'); // never released: the "process" died
    const t0 = Date.now();
    const release = await limiter(redisB).acquire('crash.test');
    const waited = Date.now() - t0;
    release();
    expect(waited).toBeGreaterThanOrEqual(300);
    expect(waited).toBeLessThan(2_000);
  });

  it('holds a lease until the request deadline, not just the lease TTL (FE-2 D3)', async () => {
    const opts = { leaseTtlMs: 300 };
    const slow = await limiter(redisA, opts).acquire('long.test', { deadlineMs: Date.now() + 1_500 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('no slot')), 800);
    await expect(limiter(redisB, opts).acquire('long.test', { signal: ac.signal })).rejects.toThrow(
      'no slot',
    );
    slow();
  });

  it('keeps a long lease when a shorter one is granted after it', async () => {
    const opts = { maxConcurrent: 2, leaseTtlMs: 300 };
    await limiter(redisA, opts).acquire('mixed.test', { deadlineMs: Date.now() + 1_500 });
    await limiter(redisB, opts).acquire('mixed.test');
    await delay(500);
    // The set must outlive the short lease's TTL (expired members are pruned on the next acquire).
    expect(await leases('mixed.test')).toBeGreaterThan(0);
  });

  it('fails at once with the wait when a cool-down outlasts the deadline (FE-2 D2)', async () => {
    await limiter(redisA).coolDown('busy.test', Date.now() + 10_000);
    const t0 = Date.now();
    const err = await limiter(redisB)
      .acquire('busy.test', { deadlineMs: t0 + 300 })
      .catch((e: unknown) => e);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(err).toBeInstanceOf(HostBusyError);
    expect((err as HostBusyError).waitMs).toBeGreaterThan(9_000);
  });

  it('makes a cool-down set by one instance delay the other', async () => {
    await limiter(redisA).coolDown('cool.test', Date.now() + 500);
    const t0 = Date.now();
    const release = await limiter(redisB).acquire('cool.test');
    release();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
  });

  it('never shortens a cool-down', async () => {
    const a = limiter(redisA);
    await a.coolDown('cool2.test', Date.now() + 500);
    await a.coolDown('cool2.test', Date.now() + 10);
    const t0 = Date.now();
    (await limiter(redisB).acquire('cool2.test'))();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
  });

  it('leaves no lease behind when a wait is aborted', async () => {
    const holder = await limiter(redisA).acquire('abort.test');
    const ac = new AbortController();
    const waiting = limiter(redisB).acquire('abort.test', { signal: ac.signal });
    setTimeout(() => ac.abort(new Error('gave up')), 100);
    await expect(waiting).rejects.toThrow('gave up');
    expect(await leases('abort.test')).toBe(1);
    holder();
    await delay(50);
    expect(await leases('abort.test')).toBe(0);
  });

  it('hands back a grant that lands after the caller aborted', async () => {
    const ac = new AbortController();
    const p = limiter(redisB).acquire('late.test', { signal: ac.signal });
    ac.abort(new Error('gave up'));
    await expect(p).rejects.toThrow('gave up');
    await delay(100);
    expect(await leases('late.test')).toBe(0);
  });
});

describe('SafeHttpClient with a shared limiter', () => {
  let server: Server;
  let base: string;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      if (hits === 1) {
        res.statusCode = 429;
        res.setHeader('retry-after', '1');
      }
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('a 429 Retry-After seen by one client delays the other', async () => {
    const client = (redis: typeof redisA) =>
      new SafeHttpClient({
        allowPrivateNetwork: true,
        userAgent: 'fe2-test',
        defaultTimeoutMs: 5_000,
        maxResponseBytes: 1024,
        perHostConcurrency: 1,
        perHostMinIntervalMs: 0,
        limiter: limiter(redis),
      });
    const [one, two] = [client(redisA), client(redisB)];
    const first = await one.request({ url: base });
    expect(first.status).toBe(429);
    expect(first.retryAfterMs).toBe(1_000);
    const t0 = Date.now();
    const second = await two.request({ url: base });
    expect(second.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    await Promise.all([one.close(), two.close()]);
  });
});
