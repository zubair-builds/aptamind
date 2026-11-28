# FE-8 — admin API startup retries after a rejected cold start

Status: **Approved 2026-11-23 by Zubair Haider (owner)**; implemented on branch
`fix/admin-api-startup-retry`. This is a Foundation Exception and an implementation PR, so it needs
two independent reviews (implementation; architecture/product) from a fresh context, not the
implementer, per `CLAUDE.md`, before the supervisor merges.

## Problem

`apps/admin/lib/api-server/handler.ts` caches `platformPromise` and `appPromise` with `??=`. If
`createPlatform('api')` or `platform.init()` rejects once (Mongo or Redis not ready at cold start,
or a transient blip) the rejected promise is cached for the life of the process. Every `/api`,
`/health`, `/ready` and `/metrics` request, and every server-side `dispatchInternal` call, then
fails until the process is restarted.

## Why a stream-local solution is insufficient

The handler is the composition-layer bootstrap shared by all streams. `STREAM_OWNERSHIP.md` makes
the composition layer additive-only, and "anything that changes existing behaviour is a Foundation
Exception". This changes the existing startup semantics for every domain's routes. No stream owns
the handler.

## Affected shared packages

- `apps/admin/lib/api-server/handler.ts` only, plus the new
  `apps/admin/lib/api-server/handler.test.ts`.
- No frozen package (`packages/*`) changes. `packages/platform` `createPlatform`, `init` and `close`
  are used unchanged.

## Proposed change (implemented)

One startup gate, with states `idle`, `starting`, `cooling` and `ready`:

- A failed attempt is never cached.
- Failure records `retryAt = now + 5s` (`STARTUP_COOLDOWN_MS`). `now` is taken when cleanup
  finishes, so the cooldown starts after `close` returns or times out.
- During the cooldown, requests fail fast with the original startup error, without re-running
  startup or logging again.
- Concurrent requests share one in-flight startup (one `createPlatform` / `init` / `buildApp`).
  After the cooldown, only the first caller starts the retry.
- If `createPlatform` succeeded but `init` or `buildApp` failed, `platform.close()` runs before the
  attempt settles. Errors from `close` are swallowed and logged. The next attempt builds a fresh
  platform. `init` is not assumed re-runnable on the same handle.
- Close is bounded by a 5s timeout and never replaces the startup error. The cooldown starts when
  cleanup finishes. A failed `close()` (for example `transport.close()` rejecting before
  `mongo.close()`) can still leave resources open, since `platform.close` is not changed
  (`packages/platform` is untouched) — a possible follow-up. The gate is per module instance, as the
  old caches were, and is not hardened against duplicate module copies or hot reload.
- Success is cached for the process lifetime, as before.
- The `handleApiRequest` signature and response mapping are unchanged.

## Compatibility impact

No change on the success path. On failure, clients still get the original error (HTTP 500 from
Next), and recover automatically after the dependency returns. `dispatchInternal` and
`getApiHealth` still report `unavailable` during failure.

Known limit, documented and not fixed here: if `createPlatform` itself rejects after partially
opening resources (for example Mongo connected, and a later step threw), `packages/platform` holds
no handle to close. Fixing that is a separate platform change.

## Migration impact

None.

## Test impact

New `apps/admin/lib/api-server/handler.test.ts` (admin vitest project) covers: a rejection is not
cached; cooldown fail-fast; a single in-flight startup; `platform.close()` when `init` or
`buildApp` fails; retry, then sticky success; the cooldown boundary; a throwing logger; a `close`
that is still pending; a synchronous `createPlatform` throw; a `close` that hangs past 5s; a
synchronous `close` throw. Existing tests are unchanged.

## Alternatives considered

- **Clear on failure, with no cooldown.** Hammers a down Mongo or Redis once per request. Rejected.
- **Process exit or restart on startup failure.** Platform-specific. Kills warm serverless isolates
  and in-flight requests. Rejected.
- **A retry loop with timers inside the handler.** Keeps isolates alive and does background work on
  serverless. Rejected.
- **Reuse the half-initialised platform and retry only `init`.** `init` idempotence is not
  guaranteed. Rejected.
