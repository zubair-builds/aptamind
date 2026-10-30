# Aptamind — Foundation + Market Intelligence

Aptamind's first engineering programme: a reusable execution foundation and the **Market
Intelligence** stream. It turns heterogeneous external sources into trustworthy, continuously
refreshable **Company**, **Job** and (schema-level) **Signal** intelligence, with provenance,
confidence, conflicts, lifecycle and human review.

> **No authentication (v0.1).** The API, worker endpoints and admin UI are an
> **internal/private operational surface**. Do not expose them to the internet. An
> authentication seam exists (`apps/admin/lib/api-server/request-context.ts`) so auth can be added without
> changing domain code.

Authoritative documents: [`docs/architecture/market-context-and-requirements.md`](docs/architecture/market-context-and-requirements.md)
(architecture authority) and [`docs/product/market-prd.md`](docs/product/market-prd.md) (PRD).
Programme status: [`docs/execution/market-foundation-status.md`](docs/execution/market-foundation-status.md).

## Architecture in one picture

```text
Source ─► Raw Snapshot ─► Observation ─► Interpretation ─► Entity Resolution ─► Reconciliation ─► Canonical
(config)   (S3 artifact)   (append-only)  (deterministic;     (company/job)        (field authority,   (Company/Job
                                           AI = proposal)                           conflicts kept)      facts + provenance)
```

- **Modular monolith + asynchronous workers** (`apps/admin` for UI/API, `apps/worker`).
- **Generic workflow runtime** (`packages/workflows`): versioned DAGs of typed capabilities,
  durable run/node state in **MongoDB**, **BullMQ/Redis** as transport only, leases, retries
  with history, timeouts, cancellation, conditional edges, bounded fan-out, subworkflows,
  wait/resume, schedules and a recovery sweeper. It knows nothing about companies or jobs.
- **Market domain** (`packages/market`) owns meaning: resolution, reconciliation, lifecycle,
  employment policy, verification, freshness and review — exposed to workflows as capabilities.

See [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md).

## Repository layout

```text
apps/
  worker/         workflow workers, scheduler, sweeper, health/metrics endpoint, seed/migrate
  admin/          Next.js internal operations UI and API route handlers
packages/
  config/         environment validation
  contracts/      ids, errors, actor seam, artifact refs, versioning primitives
  db/             MongoDB connection, collection specs, migrations, transactions
  queue/          BullMQ/Redis transport
  storage/        S3-compatible object storage + content-addressed artifact store
  net/            SSRF-safe HTTP client, host scope, per-host rate limiting
  observability/  pino logging with correlation ids, metrics registry, tracing seam
  ai/             provider-neutral AI gateway (structured output, provenance metadata)
  provenance/     evidence, confidence, facts, deterministic field selection
  taxonomy/       versioned countries/regions/timezones/currencies/roles/skills
  workflow-sdk/   capability contract, workflow spec, errors, services
  workflows/      the generic runtime (engine, registry, catalog, scheduler, sweeper)
  workflow-nodes/ generic capabilities (triggers, http, browser, csv/json, map/filter, …)
  market/         Market Intelligence domain + market capabilities + workflow templates
  platform/       composition root shared by api/worker/scripts
  testing/        integration-test harness and runtime integration tests
docs/             architecture, decisions (ADRs), runbooks, guides, execution status
```

## Quick start

Prerequisites: Node.js ≥ 22.12, pnpm 10 and Docker (Compose plugin). Native binaries are an optional fallback (see the local-development runbook).

```bash
pnpm install
cp .env.example .env            # optional; defaults work for local development
pnpm infra:up                   # MongoDB (replica set) + Redis + S3 (SeaweedFS) via Docker Compose
#   or: pnpm infra:local        # same services from native binaries (see runbook)
pnpm db:migrate                 # collections, validators, indexes, workflows, system sources
pnpm dev:worker                 # terminal 1 — worker (health on http://127.0.0.1:4101/health)
pnpm dev:admin                  # terminal 2 — UI/API on http://127.0.0.1:3000
pnpm seed:dev -- --demo         # register the UK sponsor source and load committed fixtures offline
```

`seed:dev` without `--demo` only registers the live UK sponsor register source (scheduled daily;
fetches gov.uk when network access is available).

## Quality gates

```bash
pnpm check              # format:check + lint + typecheck + unit tests + golden evaluation
pnpm test               # unit tests
pnpm test:integration   # integration tests (needs the local infrastructure running)
pnpm eval:golden        # golden cases: resolution, lifecycle, reconciliation, employment intelligence
pnpm build              # api + worker bundles, admin production build
pnpm docs:data-model    # regenerate docs/architecture/data-model.md from collection specs
```

## Documentation

- Architecture: [system overview](docs/architecture/system-overview.md) ·
  [workflow runtime](docs/architecture/workflow-runtime.md) ·
  [market domain](docs/architecture/market-domain.md) ·
  [data model](docs/architecture/data-model.md)
- Decisions: [`docs/decisions/`](docs/decisions/)
- Runbooks: [local development](docs/runbooks/local-development.md) ·
  [Vercel deployment](docs/runbooks/vercel-deployment.md) ·
  [source failure](docs/runbooks/source-failure.md) ·
  [reprocessing](docs/runbooks/reprocessing.md) ·
  [review queue](docs/runbooks/review-queue.md)
- Guides: [generic capability](docs/guides/generic-capability.md) ·
  [market capability](docs/guides/market-capability.md) ·
  [connector / provider adapter](docs/guides/connector-adapter.md) ·
  [workflow template](docs/guides/workflow-template.md) ·
  [sources & reprocessing](docs/guides/sources.md) ·
  [review items](docs/guides/review-items.md) ·
  [tracing provenance](docs/guides/provenance.md)
