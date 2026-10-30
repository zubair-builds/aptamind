import { createHash, randomUUID } from 'node:crypto';
import { raceAbort, sleep } from './abort';
import { HostBusyError, type AcquireOptions, type HostLimiter } from './rate-limiter';

/** The script commands the limiter needs. ioredis's `Redis` fits, so this package needs no driver. */
export interface RedisScriptClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  evalsha(sha1: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisHostRateLimiterOptions {
  redis: RedisScriptClient;
  /** Prepended to every key, e.g. `aptamind:` gives `aptamind:net:host:<host>:leases`. */
  keyPrefix: string;
  maxConcurrent: number;
  minIntervalMs: number;
  /**
   * A crashed holder's lease frees itself after this long. An acquire with a later deadline
   * holds its lease until that deadline plus a margin, so a slow request never loses its slot.
   */
  leaseTtlMs: number;
  /** Longest single wait while the host is full. Releases are not pushed to waiters, so they poll. */
  busyPollMs?: number;
  /** Random extra wait, so pollers on many processes do not wake in step. */
  jitterMs?: number;
  /**
   * Release and cool-down write failures. They are reported, not thrown: the caller already has
   * its response, and a lease that was not removed expires after `leaseTtlMs` anyway.
   */
  onError: (err: unknown, op: 'acquire' | 'release' | 'coolDown', host: string) => void;
}

// All timestamps come from Redis TIME, so clock skew between workers cannot widen the budget.
const NOW_MS = `local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

/**
 * KEYS: leases (sorted set, score = expiry ms), next allowed start (ms), cool-down end (ms).
 * ARGV: maxConcurrent, minIntervalMs, leaseMs, busyPollMs, leaseId.
 * Returns 0 when the lease is granted, otherwise the ms to wait before asking again.
 */
const ACQUIRE = `${NOW_MS}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local cool = tonumber(redis.call('GET', KEYS[3]) or '0')
if cool > now then return cool - now end
local nextStart = tonumber(redis.call('GET', KEYS[2]) or '0')
if nextStart > now then return nextStart - now end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return math.max(1, math.min(tonumber(first[2]) - now, tonumber(ARGV[4])))
end
local ttl = tonumber(ARGV[3])
redis.call('ZADD', KEYS[1], now + ttl, ARGV[5])
-- Leases differ in length: keep the set until its longest lease ends, never shorter.
local last = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
redis.call('PEXPIRE', KEYS[1], tonumber(last[2]) - now)
local interval = tonumber(ARGV[2])
if interval > 0 then redis.call('SET', KEYS[2], now + interval, 'PX', interval) end
return 0
`;

/** KEYS: leases. ARGV: leaseId. */
const RELEASE = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

/** KEYS: cool-down end. ARGV: duration ms. Never shortens a cool-down already in place. */
const COOL_DOWN = `${NOW_MS}
local d = tonumber(ARGV[1])
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if now + d > cur then redis.call('SET', KEYS[1], now + d, 'PX', d) end
return 0
`;

/** Lease time beyond the request deadline, for the release round trip after a timeout. */
const LEASE_MARGIN_MS = 5_000;

interface Script {
  body: string;
  sha: string;
}
const script = (body: string): Script => ({ body, sha: createHash('sha1').update(body).digest('hex') });
const SCRIPTS = { acquire: script(ACQUIRE), release: script(RELEASE), coolDown: script(COOL_DOWN) };

/**
 * `HostLimiter` whose budget lives in Redis, so every worker process shares one per-host
 * concurrency limit, start spacing and cool-down. Each acquire is one atomic script call.
 */
export class RedisHostRateLimiter implements HostLimiter {
  private readonly busyPollMs: number;
  private readonly jitterMs: number;

  constructor(private readonly opts: RedisHostRateLimiterOptions) {
    this.busyPollMs = opts.busyPollMs ?? 100;
    this.jitterMs = opts.jitterMs ?? 25;
  }

  async acquire(host: string, { signal, deadlineMs }: AcquireOptions = {}): Promise<() => void> {
    const keys = this.keys(host);
    for (;;) {
      signal?.throwIfAborted();
      const leaseId = randomUUID();
      const leaseMs =
        deadlineMs === undefined
          ? this.opts.leaseTtlMs
          : Math.max(this.opts.leaseTtlMs, Math.ceil(deadlineMs - Date.now()) + LEASE_MARGIN_MS);
      const wait = await raceAbort(
        this.run(
          SCRIPTS.acquire,
          [keys.leases, keys.next, keys.cool],
          [this.opts.maxConcurrent, this.opts.minIntervalMs, leaseMs, this.busyPollMs, leaseId],
        ),
        signal,
        (late) => {
          // The caller gave up while the script ran: hand back a grant nobody will use.
          if (late.status === 'rejected') this.opts.onError(late.reason, 'acquire', host);
          else if (late.value === 0) this.releaser(host, keys.leases, leaseId)();
        },
      );
      if (wait === 0) return this.releaser(host, keys.leases, leaseId);
      // Waiting past the deadline only ends in a timeout; tell the caller when to come back.
      if (deadlineMs !== undefined && Date.now() + wait > deadlineMs) throw new HostBusyError(host, wait);
      await sleep(wait + Math.floor(Math.random() * this.jitterMs), signal);
    }
  }

  /** Resolves once written, for tests; `HostLimiter` callers do not wait for it. */
  async coolDown(host: string, untilEpochMs: number): Promise<void> {
    // Only the remaining duration crosses the wire; the script anchors it to Redis TIME.
    const ms = Math.ceil(untilEpochMs - Date.now());
    if (ms <= 0) return;
    try {
      await this.run(SCRIPTS.coolDown, [this.keys(host).cool], [ms]);
    } catch (err) {
      this.opts.onError(err, 'coolDown', host);
    }
  }

  private releaser(host: string, leasesKey: string, leaseId: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.run(SCRIPTS.release, [leasesKey], [leaseId]).catch((err: unknown) =>
        this.opts.onError(err, 'release', host),
      );
    };
  }

  private keys(host: string) {
    // Hash tag: all keys of one host land in one Redis Cluster slot, as a script requires.
    const base = `${this.opts.keyPrefix}net:host:{${host}}`;
    return { leases: `${base}:leases`, next: `${base}:next`, cool: `${base}:cool` };
  }

  private async run(s: Script, keys: string[], args: (string | number)[]): Promise<number> {
    try {
      return Number(await this.opts.redis.evalsha(s.sha, keys.length, ...keys, ...args));
    } catch (err) {
      // First call after a Redis restart or SCRIPT FLUSH: load the body once, then evalsha works.
      if (!/NOSCRIPT/.test((err as Error | undefined)?.message ?? '')) throw err;
      return Number(await this.opts.redis.eval(s.body, keys.length, ...keys, ...args));
    }
  }
}
