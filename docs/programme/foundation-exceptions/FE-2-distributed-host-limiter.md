# FE-2 — shared per-host request budget in `@aptamind/net`

Status: **Merged 2026-10-01** (PR 38, merge commit e24e49a). Full CI green (run 36852354429). Foundation is frozen again.
Owner decision: DECISION_LOG 2026-10-01 "Distributed politeness is required for horizontal scale".
Listed as a candidate in `streams/market.md` § 4.

## Problem

`HostRateLimiter` (`packages/net/src/rate-limiter.ts`) keeps its per-host concurrency and spacing
in a process-local `Map`. Every worker process gets the full budget, so N workers send N times the
intended request rate to one host. `SafeHttpClient` builds the limiter privately, so nothing can
replace it. There is no Retry-After handling: after a 429 or 503 each process keeps its own pace,
and the next request from another worker hits the host straight away.

## Why a stream-local solution is insufficient

The limiter sits inside the client every capability uses (`NET_CLIENT`). A Market-local limiter
would mean a second network stack around the client, which the owner ruled out, and it would not
cover Foundation nodes such as `core.http_fetch` and `core.browser_crawl`.

## Affected shared packages

`packages/net` (client and limiter), `packages/config` (two settings), `packages/platform`
(composition: build the Redis limiter and pass it in).

## Change

1. **Seam.** `HostLimiter` interface: `acquire(host, signal?) → release()` and
   `coolDown(host, untilEpochMs)`. `SafeHttpClientOptions.limiter?: HostLimiter`. Default stays
   the in-process `HostRateLimiter`, which also gains `coolDown`.
2. **Shared limiter.** `RedisHostRateLimiter` in `packages/net`. It takes a minimal Redis client
   interface (`eval`-style call), so `packages/net` gains no dependency. Per host it keeps:
   - a sorted set of active leases (member = lease id, score = expiry), so a crashed worker's
     lease frees itself after the lease TTL;
   - a "next allowed start" timestamp that enforces the minimum spacing across all processes;
   - a cool-down timestamp set from Retry-After.
     One Lua script grants or refuses atomically and returns the wait time; the caller sleeps with
     jitter and tries again, bounded by the request's abort signal.
3. **Retry-After.** The client parses `Retry-After` (seconds or HTTP date) on 429 and 503, caps it
   (default 1 h), exposes `retryAfterMs` on the response and on `HttpError`, and calls
   `limiter.coolDown(host, now + retryAfterMs)`. It does not retry by itself; retry policy stays
   with the workflow runtime.
4. **Config.** `NET_HOST_LIMITER=redis|memory` (default `redis`) and `NET_HOST_LEASE_TTL_MS`
   (default 120 000). Platform builds the Redis limiter from the existing Redis connection.

## Compatibility impact

Additive. Callers that do not pass a limiter keep the current behaviour. `NET_CLIENT` keeps its
type. `memory` restores today's behaviour exactly.

## Migration impact

None (no stored data). Redis keys use the existing `QUEUE_PREFIX` namespace plus `net:host:`.

## Test impact

Unit tests for Retry-After parsing and the in-process cool-down. Integration tests against real
Redis: two limiter instances (two "processes") share one budget (concurrency and spacing hold
across both); an expired lease is reclaimed; a cool-down set by one instance delays the other; an
aborted wait leaves no lease behind. Full Foundation regression and one full CI dispatch.

## Alternatives considered

- **One dedicated I/O worker** (the old interim plan). Simple, but caps throughput at one process
  and fails the horizontal-scale requirement.
- **BullMQ group rate limiting.** Limits jobs, not HTTP requests; one job makes many requests to
  one host.
- **Market-local wrapper around the client.** Ruled out by the owner; would miss Foundation nodes.

## Implementation notes

- `HostLimiter` lives in `packages/net/src/rate-limiter.ts`. `HostRateLimiter` implements it. Its
  waiters now re-check the cool-down after every sleep, and an aborted wait frees its slot.
- `RedisHostRateLimiter` (`redis-rate-limiter.ts`) takes a local `RedisScriptClient` type with
  `eval` and `evalsha` only. ioredis fits it, so `packages/net` has no new dependency.
- Acquire, release and cool-down are each one Lua script, called by SHA with a fallback to the
  body on `NOSCRIPT`. Every timestamp comes from Redis `TIME`. Keys are
  `<QUEUE_PREFIX>:net:host:{<host>}:leases`, `:next` and `:cool`, and each key has a TTL, so idle hosts leave
  nothing behind.
- When a host is full, the script returns the time to the oldest lease expiry, capped at 100 ms.
  Releases are not pushed to other processes, so a waiter polls. Each wait adds up to 25 ms of
  jitter.
- `coolDown` sends only the remaining duration, and the script adds it to Redis `TIME`. So client
  clock skew cannot move the shared deadline. A cool-down is never shortened.
- An acquire that is aborted while its script runs gives back any lease the script then grants.
- Release and cool-down write failures go to an `onError` callback (the platform logs them as
  warnings). They do not fail the request, because the response is already in hand and a lost
  lease expires after the lease TTL. Acquire failures do fail the request, as a retryable
  `HttpError`.
- Retry-After parsing (`retry-after.ts`) accepts delay-seconds and the three HTTP-date forms. It
  rejects anything else, because `Date.parse` alone accepts values such as `5.5`.
- The platform reuses the transport's Redis connection. If Redis is down, the queue is down as
  well, and each wait stays bounded by its request timeout.
- Addition: config refuses `NET_HOST_LEASE_TTL_MS` that is not greater than
  `NET_DEFAULT_TIMEOUT_MS`. A lease that expires mid-request would let the host get more than its
  budget.
- The integration tests are in `packages/platform/src/redis-host-limiter.int.test.ts`. The
  platform already depends on `@aptamind/queue` for a Redis connection, and `packages/net` must
  not.

Review repairs (PASS WITH FIXES):

- D1: the client no longer awaits `coolDown`. It is fire-and-forget, and a stalled Redis cannot
  hold a response or its lease.
- D2: `acquire` takes the request deadline. A wait that ends after it fails at once with
  `HostBusyError`, which the client turns into a retryable `HttpError` with `retryAfterMs`.
- D3: each lease lasts at least until the request deadline plus 5 s, so a request with a long
  `timeoutMs` keeps its slot. The lease set's own TTL follows its longest lease.
- D4: repeated `Retry-After` values joined by commas give the longest valid wait.
- D5: keys use a Redis Cluster hash tag: `<QUEUE_PREFIX>:net:host:{<host>}:*`.
