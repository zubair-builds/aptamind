# FE-7 — optional user-authentication env names in `packages/config`

Status: **Implemented on a2/m-u2b-better-auth (PR #10)** (owner approved 2026-10-31: Zubair,
relayed by Manager).

## Problem

M-U2b (ADR-0022) mounts Better Auth at `/api/auth/*` behind a flag. Its settings come from the
environment: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`ADMIN_EMAIL` and `AUTH_ENABLED`. Every other variable is declared and validated in
`envSchema` (`.env.example` says "All variables are validated at startup by @aptamind/config"),
but these six were not.

## Why a local fix is not enough

`envSchema` is the single declaration of the app's environment, and it lives in
`@aptamind/config`, which is frozen. Declaring the names only in `apps/admin` or
`packages/identity` would leave a second, unvalidated list of env variables.

## Packages affected

- `packages/config` (frozen): `src/index.ts` `envSchema`.
- `.env.example`: the six names, without values.
- Consumers: `apps/admin` reads them from `process.env`, the same way it reads `ADMIN_PASSWORD`
  (admin may not depend on `config`); `@aptamind/identity/better-auth` builds Better Auth from
  them.

## Change

Six fields are added to `envSchema`, all optional:

- `AUTH_ENABLED`: boolean (same parser as other flags), default `false`.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: optional strings (blank = unset).
- `BETTER_AUTH_SECRET`: optional, at least 32 characters when set.
- `BETTER_AUTH_URL`: optional http(s) URL.
- `ADMIN_EMAIL`: optional email.

## Compatibility

- Additive: no existing field changes; with none of the six set, parsing gives the same result
  plus `AUTH_ENABLED: false`.
- The parsed `AppConfig` object returned by `loadConfig` is unchanged (no new keys); no caller
  changes.
- No migration.

## Tests

- `packages/config` unit tests pass unchanged (`config.test.ts`).
- `apps/admin/middleware.test.ts`: with `AUTH_ENABLED` unset or `false`, behaviour is unchanged.
