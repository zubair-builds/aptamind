# System overview

## Shape

Aptamind v0.1 is a **modular monolith with a Next.js UI/API and asynchronous workers**:

| Process       | Responsibility                                                                                                                                            | Scales by                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `apps/admin`  | Next.js operations UI and same-origin HTTP API. Starts runs; never executes heavy work inline. API routes use the embedded server composition.            | Replicas behind a private network                                                                           |
| `apps/worker` | Executes workflow nodes and fan-out chunks from BullMQ, fires schedules, runs the recovery sweeper. Exposes `/health`, `/ready`, `/metrics` on localhost. | More processes; `WORKER_QUEUES` dedicates a worker to a capability class (`default`, `io`, `browser`, `ai`) |

Infrastructure: **MongoDB** (replica set, source of truth), **Redis/BullMQ** (transport only),
**S3-compatible storage** (SeaweedFS locally via Docker Compose) for raw artifacts.

```text
            ┌──────────── admin (Next.js UI + /api) ────────────┐
            │ server components + server actions + API routes   │
            └───────────────────┬────────────────────────────────┘
                                │ same-origin (internal only, no auth)
┌───────────────────────────────▼───────────────────────────────┐
│ domain API handlers (Fastify app.inject inside Next.js)       │
│   MarketDomain (services)      WorkflowEngine.startRun/cancel  │
└──────────────┬──────────────────────────────┬─────────────────┘
               │ MongoDB (state)               │ BullMQ (wake-ups)
┌──────────────▼──────────────────────────────▼─────────────────┐
│ worker: WorkflowWorkerHost (node + fan-out queues)             │
│         Scheduler (Mongo-driven) · Sweeper (lease/lost-job recovery) │
│         capabilities: generic (packages/workflow-nodes)        │
│                       market  (packages/market/workflow-nodes) │
└──────────────┬──────────────────────────────┬─────────────────┘
               │ S3 (artifacts)                │ outbound HTTP (SSRF-safe), headless browser, AI gateway
```

## Package dependency rules

```text
contracts, config, observability, provenance, taxonomy   (leaf primitives)
db, queue, storage, net, ai                               (infrastructure)
workflow-sdk  ◄─  workflows (engine)                      (generic runtime; no domain imports)
workflow-sdk  ◄─  workflow-nodes (generic capabilities; never the engine)
market  ─► (workflow-sdk, workflow-nodes tokens, provenance, taxonomy, db, storage, net, ai)
           (the engine only as a dev dependency, for its test harness)
platform (composition root) ─► everything
apps ─► platform (+ market types)
```

Enforced by `scripts/check-architecture.ts` (`pnpm check:arch`, in `pnpm check` and CI) from
both package manifests and source imports — an explicit allow-list per package, no shared
package may depend on a domain package, domains may not depend on each other, only the queue
adapter/worker host may import BullMQ — and by ESLint `no-restricted-imports` (no deep
imports; shared packages cannot import `@aptamind/market`; the admin cannot import
persistence/queue packages). A future domain (Professional, Opportunity) is a new package
beside `market` that contributes capabilities, services and workflows through the same SDK.

## Architecture laws (how they are implemented)

| Law                           | Implementation                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — observation is not truth  | Adapters emit `JobObservationPayload`/`CompanyObservationPayload`; observations are append-only; canonical documents are only written by reconcilers.       |
| B — workflow ≠ business logic | Workflow specs only compose capabilities; policies live in `packages/market` (resolver, reconcilers, lifecycle, interpreter).                               |
| C — runtime is generic        | `packages/workflows` has no domain imports (lint-enforced); domain reaches it via capabilities and `ServiceRegistry` tokens.                                |
| D — flexible granularity      | `core.parse_csv` and `market.process_sponsor_row` use the same `CapabilityDefinition` contract; subworkflows turn proven compositions into one step.        |
| E — durable state in Mongo    | Runs, node runs, chunks, schedules in Mongo; BullMQ jobs are pointers; the sweeper rebuilds transport state.                                                |
| F — idempotency               | Deterministic ids, unique indexes (`identityKeys`, `sourceKeys`, `idempotencyKey`, `dedupeKey`), leases, per-item idempotency keys.                         |
| G — ambiguity is explicit     | `unknown`/`conflicting` facts, `unclear` classifications, review items with dedupe keys.                                                                    |
| H — AI cannot mutate truth    | AI outputs are schema-validated proposals stored with provenance (`aiProposals`, observation `ai` metadata); deterministic policy derives canonical values. |

## Reliability properties (tested)

- Next.js restart mid-run: run completes; state readable from a fresh API instance (`apps/admin/lib/api-server/api.int.test.ts`).
- Worker SIGKILL mid-node: lease expires, another worker takes over, attempt history shows `lost` → `completed`, side effects idempotent (`packages/testing/src/runtime/runtime.int.test.ts`).
- Redis job loss or outage: completed state stays fully readable from Mongo, new runs are
  accepted durably, and the sweeper re-dispatches once Redis is back.
- Restart after interruption resumes A → B → C at C; completed nodes are never re-executed,
  even when re-delivered.
- Failure after a side effect but before acknowledgement (crash or failed completion write)
  leaves exactly one durable effect.
- Retries are bounded with exponential backoff; terminal errors are not retried; fan-out never
  exceeds its concurrency bound (100 items at concurrency 10, with lineage).
  (`packages/testing/src/runtime/runtime-gate.int.test.ts`)
- Source fetch failure never changes job state; anomalous datasets never mass-delist (`packages/market/src/market.int.test.ts`).

## Security posture (v0.1)

- No authentication — internal network only; `loadConfig` refuses `API_HOST=0.0.0.0` and private-network fetching in production.
- Outbound requests: http/https only, no credentials in URLs, private/loopback/link-local/metadata addresses blocked at DNS-resolution time (defeats rebinding and redirects), host scoping for crawls, response-size and time limits, per-host politeness.
- Browser: isolated context per page, every request validated, navigation restricted to scope, media/fonts/images blocked, downloads and service workers disabled.
- Artifacts are private; the API serves them as `text/plain` with `nosniff` and a `default-src 'none'` CSP.
- Secrets are referenced by name (`CredentialRef` / `AI_API_KEY_ENV`), never stored in workflow definitions or source configs; logs redact common secret fields.
