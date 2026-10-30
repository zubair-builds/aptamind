# FE-3 — explicit storage endpoint and credentials in `@aptamind/config` and `@aptamind/storage`

Status: **Approved by the supervisor (2026-10-01); implementation on foundation/fe-3-storage-endpoint**.
Trigger: incident of 2026-10-01 (storage reached real Amazon S3 by accident).

## Problem

`S3_ENDPOINT` was optional with no default (`packages/config/src/index.ts`). The apps read only
`process.env` and did not load `.env`. A dev stack started without `.env` therefore gave the AWS
SDK no endpoint. The SDK fell back to real Amazon S3 and used the ambient AWS credentials on the
owner's Mac (`~/.aws`, `AWS_PROFILE`).

The storage adapter's boot step (HeadBucket, then CreateBucket) then created a real bucket,
`aptamind-artifacts`, in the owner's AWS account. Artifacts were written there. Nobody intended
this. Storage must never silently reach an unintended external endpoint.

Two silent fallbacks caused it:

- no endpoint means "Amazon S3";
- no static keys means "whatever ambient AWS credentials exist".

## Why a local fix is insufficient

Every process gets its storage settings from `loadConfig` and its client from `S3ObjectStorage`.
Both are frozen Foundation packages. A check in one app would miss the other app, the scripts and
the test helpers. Some callers also build `S3ObjectStorage` directly, without config (for example
the crash-recovery test worker). So the guard must live in config and in the adapter itself.

## Affected packages

- `packages/config` (frozen): endpoint rules and one new setting.
- `packages/storage` (frozen): the client fails closed. This is included in FE-3 on purpose.
- Composition, not frozen: `packages/platform` (one re-export), `apps/worker/src/dev/drop-env.ts`,
  `test/integration-setup.ts`, `.env.example` and the local-development runbook.

## Change

1. **Config.** `S3_ENDPOINT` is required and must be an `http://` or `https://` URL. A blank value
   counts as unset. The only way to use the AWS default endpoint is the explicit opt-in
   `S3_USE_AWS_DEFAULT_ENDPOINT=true`, with `S3_ENDPOINT` unset. Setting both is refused. A
   missing endpoint fails config loading with a message that names `S3_ENDPOINT`, points at
   `.env.example` and names the opt-in. No message prints a value. A blank `S3_REGION` also
   counts as unset and falls back to `us-east-1`.
2. **Credentials.** `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are both required on every
   path, the AWS opt-in included. Config refuses to load without them. So the AWS SDK default
   credential chain (`~/.aws`, `AWS_PROFILE`, instance metadata) is never reached.
   `AppConfig.s3` gains `useAwsDefaultEndpoint`.
3. **Storage.** New `s3ClientConfig(opts)` in `packages/storage/src/object-storage.ts`.
   `S3ObjectStorage` builds its client through it. It throws when the endpoint is missing without
   the opt-in, when both are set, or when either key is missing. This holds even when a caller
   skips config. `S3StorageOptions` gains an optional `useAwsDefaultEndpoint`.
4. **No `.env` auto-load.** Scripts do not load `.env`. The operator exports it into the shell
   first (`set -a; . ./.env; set +a`). An earlier draft of FE-3 added Node's
   `--env-file-if-exists` to the app scripts. Review removed it: the root `.env` holds the MVP R2
   settings, so `pnpm seed:dev --demo` would have written demo fixtures into R2 and the MVP
   database. That breaks the 2026-10-01 rule that fixture data never mixes with MVP data. The
   fail-closed config (points 1 to 3) is what stops the incident, not `.env` loading.
5. **Drop script.** `apps/worker/src/dev/drop-env.ts` built its own S3 client with the same
   fallback. It now uses `s3ClientConfig`, which `packages/platform` re-exports. The layering
   rule lets apps reach storage only through the platform.

## Compatibility

- Breaking for a process started without `S3_ENDPOINT`: it now fails at boot instead of writing to
  Amazon S3. That is the intent.
- Breaking for an explicit endpoint without static keys: it now fails at boot instead of using
  ambient credentials. No supported setup relied on this.
- CI (`.github/workflows/ci.yml`), the integration setup (`test/integration-setup.ts`) and the
  admin e2e smoke already set `S3_ENDPOINT` and both keys explicitly. The integration setup now
  hard-sets the local test values, so a shell that exported the R2 settings cannot send
  integration tests to R2. Only `TEST_S3_*` variables override them. `docker-compose.yml` runs
  only infrastructure and needs no change.
- Market, Professional and Admin code do not build storage clients. No domain change.

## Migration

No stored data changes. Each environment needs `S3_ENDPOINT` and both keys, or the AWS opt-in.
For local development: `cp .env.example .env`, then `set -a; . ./.env; set +a` in the shell that
runs the scripts.

The stray AWS bucket `aptamind-artifacts` and its objects are not touched by this change. Removing
them is an owner action in the AWS account.

## Tests

- `packages/config/src/config.test.ts`: missing or blank endpoint (message names `S3_ENDPOINT`,
  `.env.example` and the opt-in, and holds no key value); non-URL endpoint; missing or partial
  keys with an explicit endpoint and with the AWS opt-in; AWS opt-in with both keys; opt-in
  together with an endpoint; blank `S3_REGION` falls back to the default. Other config tests now
  pass an explicit local endpoint.
- `packages/storage/src/object-storage.test.ts`: `s3ClientConfig` uses only the static keys with
  an endpoint and with the opt-in, refuses a missing endpoint, refuses missing or partial keys on
  both paths without printing them, refuses the opt-in with an endpoint, and `S3ObjectStorage`
  built directly fails closed.
- Unit suite, integration tests that build storage, and one full CI dispatch before merge.

## Alternatives

- **Default `S3_ENDPOINT` to local SeaweedFS.** Rejected. A production process with a missing
  value would then write to a local address and fail later, or hide a misconfiguration. An
  explicit value is clearer.
- **Refuse the AWS endpoint completely.** Rejected. Amazon S3 is a valid provider for the
  provider-neutral adapter. The opt-in keeps it possible but never silent.
- **Load `.env` automatically in the scripts** (Node `--env-file-if-exists` or `dotenv`).
  Rejected in review. One root `.env` cannot tell a demo seed from an MVP run, so fixture data
  could reach the MVP store. The operator exports the settings on purpose instead.
- **Guard only in config.** Rejected. Callers that build `S3ObjectStorage` directly would keep the
  fallback.

## Implementation notes

- An explicit `https://s3.amazonaws.com` endpoint with both static keys is allowed. Besides the
  opt-in, it is the only way to reach Amazon S3.
- Next.js (`apps/admin`) is unchanged. It reads `NEXT_PUBLIC_APP_URL`, which has a local default, and
  `ADMIN_UI_CATALOGUE` (`apps/admin/app/settings/ui/page.tsx`). It reads no storage setting.
