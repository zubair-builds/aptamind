# Aptamind — agent operating guide

Aptamind turns heterogeneous evidence into trustworthy, provenance-backed intelligence about the
**market** (companies, jobs, employment conditions) and about **professionals** (what is true about a
person, what supports it, what they confirmed, what they target). A later Opportunity Intelligence
domain will join the two. This file is the entry point for any Claude session; details live in
[`docs/programme/`](docs/programme/APTAMIND_PROGRAMME.md).

## Resume here

1. Read [`docs/programme/PROGRAMME_STATE.yaml`](docs/programme/PROGRAMME_STATE.yaml) — streams, branches,
   worktrees, open PRs, blockers and the exact next task per stream.
2. Read the stream file you are working on under `docs/programme/streams/`.
3. Check `git worktree list`, open PRs and CI on `main`, then continue the next task. Do not wait
   for the owner unless the escalation policy below requires it.

## Authority order (higher wins; never silently override)

1. Explicit current owner decisions (recorded in `docs/programme/DECISION_LOG.md`).
2. Frozen Foundation architecture at tag `foundation-v0.1` = `d9799b6a2ae42a3799b25a1a0f39bb09bd857698`.
3. Canonical ADRs (`docs/decisions/`).
4. Market / Professional stream contracts (`docs/architecture/*`, `docs/product/*`, `docs/programme/contracts/`).
5. Programme decisions (`docs/programme/DECISION_LOG.md`).
6. PR / task contract.
7. Implementation details.

## Architectural invariants (frozen)

- Modular monolith + async workers: `apps/admin` (Next.js UI/API), `apps/worker`; API route modules are embedded in the admin server.
- MongoDB is durable truth; Redis/BullMQ is transport only; S3 holds content-addressed raw artifacts.
- The workflow runtime (`packages/workflows`) is generic — no domain imports. Domains contribute capabilities via `workflow-sdk`.
- Observation is not truth: source → snapshot → observation → interpretation → resolution → reconciliation → canonical, with provenance, confidence and conflicts kept.
- AI never mutates truth: schema-validated proposals with provider/model/prompt-version metadata; deterministic policy decides.
- Idempotency, leases, generation/revision fencing and replay safety on every canonical write.
- Unknown stays unknown; ambiguity is explicit (`unknown`/`conflicting`, review items).
- Professional: user-confirmed facts outrank model inference; contradictions become conflicts, never silent replacement; history is never destroyed.
- Professional Fit ≠ Application Viability (visa/location/sponsorship are viability).
- Auth (D1, 2026-10-31, partially supersedes ADR-0008): approved users/auth work only — Better Auth + Google sign-in, admin/user roles with permissions, single workspace; `Actor` seam on every mutation.
- Users/auth/UI/MCP plan: docs/programme/plans/users-ui-mcp.md.

## Domain boundaries and stream ownership

| Owner               | Owns                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation (frozen) | `packages/{contracts,config,db,queue,storage,net,observability,ai,provenance,taxonomy,workflow-sdk,workflows,workflow-nodes,testing}`   |
| Market (Stream A)   | `packages/market/**`, Market API routes, Market fixtures/evals/docs                                                                     |
| Professional (B)    | `packages/professional/**`, Professional API routes, fixtures/evals/docs                                                                |
| Admin UX (C)        | `apps/admin/**` (and `packages/ui/**` if created), design tokens, presentation                                                          |
| Supervisor          | `CLAUDE.md`, `docs/programme/**`, CI, `scripts/check-*.ts`, root configs, composition (`packages/platform`, app bootstraps) arbitration |

Domains never import each other. Domain streams never edit `apps/admin`; they publish UI/API
contracts in `docs/programme/contracts/`. The UI never derives domain truth. Changing a frozen
package requires a Foundation Exception (`docs/programme/foundation-exceptions/`). Full rules:
[`STREAM_OWNERSHIP.md`](docs/programme/STREAM_OWNERSHIP.md).

## Local validation

```bash
pnpm install
pnpm infra:up                # Mongo rs0 + Redis + SeaweedFS (docker compose); start dockerd first if needed
pnpm check                   # format:check, lint, typecheck, check:deps, check:arch, unit, golden
pnpm test:integration        # needs infra; tests use random DB names/queue prefixes (safe in parallel)
pnpm build
```

**FULL GITHUB CI = MANUAL MILESTONE CERTIFICATION. NORMAL DEVELOPMENT = LOCAL-FIRST.**
`.github/workflows/ci.yml` (all of the above plus sandboxed-Chromium browser suites and admin e2e) is
`workflow_dispatch` only; no PR or push runs it. Normal PRs merge on the local gate (format/lint,
typecheck, unit and integration tests of the affected packages, relevant golden/semantic/property
tests); docs-only PRs need `pnpm format:check` only. The supervisor dispatches full CI exactly once
(`gh workflow run ci.yml --ref main`) for a milestone candidate, release/deployment candidate,
Foundation Exception, major shared-runtime/security/concurrency change or owner request, and waits
for the completion notification (no polling). Runner/infra failure: re-run failed jobs only, once.
Code failure: fix locally, re-run the local gate, one new candidate, one dispatch. Review budget: one
independent pass, one focused repair verification if needed, 2–3 passes maximum; the same defect
family three times means redesign the abstraction. Policy: `DECISION_LOG.md` 2026-10-01.

## Autonomous operating policy

- Work autonomously; choose the simplest option that preserves correctness, security,
  observability and product quality; log meaningful decisions in `DECISION_LOG.md`.
- Every implementation PR gets two independent reviews (implementation; architecture/product) from a
  fresh context, not the implementer. Test counts are not evidence — read the code; use adversarial
  and mutation tests where replay, races, idempotency or canonical truth are involved.
- Supervisor merges a PR when both reviews pass, the local gate is green (full CI only where the
  policy above requires it), no Blocker/High is open, no forbidden Foundation change, and integration
  contracts hold.
- Escalate to the owner only for: product-defining choices not inferable; externally irreversible
  actions; major Foundation changes; destructive data migrations; paid third-party commitments;
  new auth/privacy/legal boundaries; product-scope changes.
- Persist state in `PROGRAMME_STATE.yaml` after each milestone and before a session ends.

## Prohibited scope (this phase)

Opportunity Intelligence / job-fit scoring, application ranking, resume generation, outreach,
autonomous applications, marketplace, employer ATS, candidate-agent autonomy, LinkedIn automation,
auth beyond the approved users/auth plan (docs/programme/plans/users-ui-mcp.md). No prestige infrastructure (Kafka, Temporal, microservices, Neo4j,
ClickHouse, OpenSearch, new vector DB, service mesh). No workflow runtime rewrite.
