# FE-9 — bound /ready health checks so a hung dependency returns quickly

Status: **Approved 2026-11-28 by Zubair Haider (owner)**; implemented on branch
`fix/ready-check-timeout`. This is a Foundation Exception and an implementation PR, so it needs
two independent reviews (implementation; architecture/product) from a fresh context, not the
implementer, per `CLAUDE.md`, before the supervisor merges.

## Problem

`packages/platform` `checks()` ran `Promise.all([mongo.ping(), transport.ping(), storage.ping()])`
with no timeout. Redis `ping()` can hang forever (`maxRetriesPerRequest` is `null` in
`packages/queue`). Mongo waits up to `serverSelectionTimeoutMS` 10s. S3 `HeadBucket` has no
timeout. The admin readiness probe (`apps/admin/lib/health.ts`) aborts at 2s then 700ms, so a hung
`/ready` never returns 503 with the failed checks and the shell can only show the generic
"unavailable" copy. The worker `/ready` handler uses the same `platform.checks()` and would hang
the same way.

## Why a stream-local solution is insufficient

`checks()` lives in the frozen composition root (`packages/platform`) and is the shared readiness
implementation for the API and the worker. A timeout only in `apps/admin/lib/api-server/routes/health.ts`
would leave the worker hanging and would still leave `checks()` itself unbounded for any other
caller. `STREAM_OWNERSHIP.md` requires a Foundation Exception for a behaviour change in the
composition layer. The hung clients themselves are in frozen `packages/queue`, `packages/db` and
`packages/storage`, which this exception does not change.

## Affected shared packages

- `packages/platform/src/ready-checks.ts` (new) — timeout helper and `runReadyChecks`.
- `packages/platform/src/ready-checks.test.ts` (new).
- `packages/platform/src/index.ts` — `checks()` delegates to `runReadyChecks`; re-exports
  `READY_CHECK_TIMEOUT_MS` and `runReadyChecks`.
- Tests only (route): `apps/admin/lib/api-server/routes/health.test.ts` (new). The `/ready` route
  itself is unchanged.
- `apps/admin/lib/health.ts` and `apps/admin/lib/health.test.ts` — the admin probe keeps a first
  `not_ready` (with checks) when the 700ms retry aborts. This is not a frozen package.
- `apps/worker/src/health-server.ts` is unchanged; it already calls `platform.checks()`, so it
  benefits automatically.
- No changes to `packages/queue`, `packages/db` or `packages/storage`.

## Proposed change (implemented)

In `checks()`, each ping is wrapped in `Promise.race` against a 1.5s timer (`READY_CHECK_TIMEOUT_MS`)
that resolves `false`. Timers are always cleared. The ping is given a rejection handler so a late
rejection after the timeout cannot become an unhandled rejection. A synchronous throw from a ping
factory also becomes `false`. The `/ready` response contract is unchanged: 200 `{ status: 'ready',
checks }` or 503 `{ status: 'not_ready', checks }` with the same `mongo` / `redis` / `objectStorage`
keys. No second timeout is added in the route handlers; the platform bound is enough and avoids
stacking delays.

1.5s is under the admin probe's first 2s budget, so a hung dependency yields a 503 with the failed
checks rather than a client abort on the first try. The probe still retries once with a 700ms
timeout (to swallow brief blips). That retry cannot wait 1.5s, so if it aborts (`unavailable`)
after a first `not_ready`, `fetchApiHealth` keeps the first result and its checks.

## Compatibility impact

On the success path, behaviour is unchanged (a timely `true` does not wait for the timer). On
failure, `/ready` now returns 503 with the failed checks within about 1.5s instead of hanging.
Callers that assumed `checks()` could block for 10s or longer will see a faster `false`. A ping that
succeeds after the timeout is ignored for that request (the next probe can still report recovery).

## Migration impact

None.

## Test impact

- New `packages/platform/src/ready-checks.test.ts` (unit project): timely true/false, rejected ping,
  hanging ping returns false at the timeout (fake timers), mixed up/hung, synchronous throw, late
  rejection with no unhandled rejection.
- New `apps/admin/lib/api-server/routes/health.test.ts` (admin project): `/ready` is 200 when all
  checks are up, and 503 with the failed checks within the bound when a ping hangs.
- `apps/admin/lib/health.test.ts`: first `not_ready` is kept when the 700ms retry is `unavailable`;
  a brief blip whose retry is `ready` still clears the notice.

## Alternatives considered

- **Timeout only in `routes/health.ts`.** Leaves the worker and any other `checks()` caller
  unbounded. Rejected.
- **Change `packages/queue` / `db` / `storage` ping implementations** to take a timeout. Broader
  frozen-package change than needed; would still need `checks()` to compose them. Rejected for this
  exception.
- **A tighter timeout (e.g. 500ms) so the 700ms admin retry also always lands.** 1.5s was the
  approved bound. The 2s first probe already receives the 503 with checks; the 700ms retry cannot
  wait 1.5s, so the probe keeps the first `not_ready` when the retry aborts, instead of shortening
  the platform bound. Rejected as the only fix.
