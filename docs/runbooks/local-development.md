# Runbook: local development

## 1. Infrastructure

MongoDB must run as a **replica set** (transactions), plus Redis and an S3-compatible store.

**Docker Compose — the supported setup** (Docker Engine ≥ 24 with the Compose plugin):

```bash
pnpm infra:up      # docker compose up -d --wait: mongo:7 (rs0), redis:7-alpine, SeaweedFS S3
pnpm infra:down    # stop (volumes are kept; `docker compose down -v` wipes them)
```

The same `docker-compose.yml` is used by CI. The replica set is initiated by the Mongo health
check on first boot; `--wait` returns once all three services are healthy.

| Service | Image                      | Address           | Notes                                                                     |
| ------- | -------------------------- | ----------------- | ------------------------------------------------------------------------- |
| MongoDB | `mongo:7`                  | `127.0.0.1:27017` | single-node replica set `rs0`                                             |
| Redis   | `redis:7-alpine`           | `127.0.0.1:6379`  | AOF on, `noeviction` (BullMQ requirement)                                 |
| S3      | `chrislusf/seaweedfs:4.47` | `127.0.0.1:9000`  | S3 API; dev credentials `aptamind` / `aptamind-dev-secret` (see ADR-0014) |

Any S3-compatible endpoint works (`S3_ENDPOINT`, `S3_FORCE_PATH_STYLE=true`); buckets are
created on startup.

**Native binaries — optional fallback** for machines that cannot run containers:

```bash
# mongod ≥ 7.0, redis-server ≥ 7 and an S3 server (`weed` or `minio`) on PATH,
# or MONGOD_BIN / REDIS_BIN / S3_BIN pointing at them
pnpm infra:local   # bash scripts/local-infra.sh start  (data in ./.local-infra)
bash scripts/local-infra.sh status
bash scripts/local-infra.sh stop
```

The script only starts processes; how the binaries are installed is a property of the machine
(OS packages, vendor downloads, …) and not part of the repository's requirements.

Defaults (`.env.example`): Mongo `127.0.0.1:27017` (rs0), Redis `127.0.0.1:6379`,
S3 `http://127.0.0.1:9000` (`aptamind` / `aptamind-dev-secret`).

## 2. Application

Scripts do not load `.env`. They read only the real environment. Create an env file and export
it into the shell that runs the scripts:

```bash
cp .env.example .env       # local SeaweedFS, Mongo and Redis defaults
set -a; . ./.env; set +a   # export every variable in .env into this shell
```

- Export the file that matches the store you mean to write. Never export the MVP settings (R2,
  the MVP database) before `seed:dev --demo`: fixture data must never mix with MVP data.
- `S3_ENDPOINT` is required. Without it, config refuses to start, so storage never falls back to
  real Amazon S3 by accident. To use Amazon S3 on purpose, leave it unset and set
  `S3_USE_AWS_DEFAULT_ENDPOINT=true` (see `.env.example` and FE-3).
- `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are always required, the AWS opt-in included.
  The storage client never uses ambient AWS credentials (`~/.aws`, `AWS_PROFILE`).
- This fail-closed config is what stops storage reaching an unintended endpoint.
- Tests do not read `.env`. Integration tests hard-set local SeaweedFS values in
  `test/integration-setup.ts`. Only `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY_ID`,
  `TEST_S3_SECRET_ACCESS_KEY` and `TEST_S3_BUCKET` override them.

```bash
pnpm install
pnpm db:migrate            # idempotent: collections, validators, indexes, workflows, system sources
pnpm dev:worker            # http://127.0.0.1:4101/health | /ready | /metrics
pnpm dev:admin             # http://127.0.0.1:3000 (UI + /health | /ready | /metrics | /api/*)
pnpm seed:dev -- --demo    # UK sponsor source + offline fixture data (see below)
```

Health checks: `curl 127.0.0.1:3000/ready` and `curl 127.0.0.1:4101/ready` return
`{"status":"ready","checks":{"mongo":true,"redis":true,"objectStorage":true}}`.

### Demo data

`seed:dev --demo` loads committed fixtures **as uploaded snapshots** (clearly labelled as
fixtures) and starts the same workflows used in production:

- UK sponsor register sample (`packages/market/fixtures/uk-sponsor/register-t1.csv`) → 16
  companies with licence evidence and 2 company-resolution reviews;
- Greenhouse (`acme`), Lever (`beta-co`) and Ashby (`gamma`) board snapshots → canonical jobs
  with employment intelligence;
- a third-party feed that syndicates two Greenhouse jobs with conflicting data.

Without `--demo`, only the live source `uk-sponsor-register` is registered (daily at 06:15
Europe/London). It needs outbound access to `www.gov.uk` and `assets.publishing.service.gov.uk`.

## 3. Checks

```bash
pnpm check                # format, lint, typecheck, dependency + architecture checks, unit tests, golden evaluation
pnpm test:integration     # requires infrastructure (uses throwaway databases t_*)
pnpm build
```

Integration tests create databases named `t_*` and drop them afterwards
(`KEEP_TEST_DB=1` keeps them for inspection). The browser suite
(`packages/testing/src/runtime/browser.int.test.ts`) **never skips**: without a usable,
sandboxed Chromium it fails. Set `BROWSER_EXECUTABLE_PATH` (below) before running the full
integration suite.

Generated documentation (commit the result after `pnpm prettier --write docs/architecture`):

```bash
pnpm docs:data-model      # docs/architecture/data-model.md from the collection definitions
pnpm docs:capabilities    # docs/architecture/capability-idempotency.md from capability contracts
```

### Continuous integration

`.github/workflows/ci.yml` runs on every pull request to `main` and every push to `main`
(Ubuntu 24.04, the same `docker-compose.yml`): install (frozen lockfile) → format, lint,
typecheck → dependency and architecture checks → unit tests → golden evaluation → Compose
infrastructure → sandboxed Chromium install → runtime/F1-gate, browser, and Market/API
integration suites → a guard that fails if any `*.int.test.ts` is not covered by one of those
steps → build. CI never contacts live external sources.

For CI to be a gate, `main` must be the repository's default branch and branch protection on
`main` must require the `checks` job of the `CI` workflow as a status check (repository owner action in GitHub settings).

### Live read-only smoke checks (optional)

```bash
pnpm smoke:live
```

Performs read-only GETs against the real sources (GOV.UK sponsor register page, Greenhouse,
Ashby and Lever public board APIs) and reports each as reachable / not reachable with what was
parsed. It writes nothing anywhere and is never part of CI; a network policy that blocks these
hosts shows up as `NOT REACHABLE`, which is an environment limitation, not a test failure.

## 4. Configuration

All variables are validated at startup (`packages/config`). Notable ones:

| Variable                                    | Purpose                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `NET_ALLOW_PRIVATE_NETWORK`                 | Allow fetching private/loopback addresses (tests/fixture servers only; refused in production)                 |
| `BROWSER_EXECUTABLE_PATH`                   | Chromium binary for `core.browser_fetch`/`core.browser_crawl` (browser capabilities fail visibly without it)  |
| `CHROMIUM_BIN`, `CHROMIUM_RUN_AS`           | Only with `scripts/chromium-unprivileged.sh` (root dev containers): the real binary and the unprivileged user |
| `API_ALLOW_UNSAFE_PUBLIC_BIND`              | Production override of the bind guard; must equal the acknowledgement phrase (see §5)                         |
| `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY_ENV` | AI gateway (`none` by default; `anthropic` uses the key from the env var named by `AI_API_KEY_ENV`)           |
| `WORKER_QUEUES`                             | Dedicate a worker to capability classes, e.g. `browser` or `ai`                                               |
| `WORKER_LEASE_MS`                           | Node/chunk lease; crashed workers' work is taken over after it expires                                        |

## 5. Exposure warning

There is **no authentication**. Bind API/admin/worker endpoints to localhost or a private
network only.

In production (`NODE_ENV=production`) the config **fails closed** unless `API_HOST` is an
explicit loopback (`127.0.0.0/8`, `::1`) or private-network IP (`10/8`, `172.16/12`,
`192.168/16`, `100.64/10`, `fc00::/7`). Refused: `0.0.0.0`, `::`, public addresses, hostnames
(including `localhost` — use `127.0.0.1`) and anything unparsable. The only override is
`API_ALLOW_UNSAFE_PUBLIC_BIND=i-understand-this-exposes-an-unauthenticated-api`, intended for
a container whose port is reachable only through a private network; never use it on an
internet-facing interface.

## 6. Browser (sandboxed Chromium)

Browser capabilities run Chromium **with its sandbox on** behind the in-process egress proxy
(see [workflow-runtime.md](../architecture/workflow-runtime.md#browser-security-model-audit-b-4)).
There is no `--no-sandbox` mode and no unsandboxed fallback.

- **Non-root worker (supported deployment):** install Chromium (for example
  `pnpm --filter @aptamind/workflow-nodes exec playwright-core install --with-deps chromium`)
  and set `BROWSER_EXECUTABLE_PATH` to it. On Ubuntu ≥ 23.10 unprivileged user namespaces are
  restricted by AppArmor; allow them (`sysctl kernel.apparmor_restrict_unprivileged_userns=0`)
  or install an AppArmor profile for Chromium.
- **Root dev container:** Chromium refuses to sandbox as root. Create an unprivileged user
  (`useradd --system --create-home aptamind-browser`) and set
  `BROWSER_EXECUTABLE_PATH=./scripts/chromium-unprivileged.sh`,
  `CHROMIUM_BIN=/path/to/chrome`, `CHROMIUM_RUN_AS=aptamind-browser`. The wrapper drops
  privileges with `setpriv` before executing Chromium.
