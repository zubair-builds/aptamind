# Integration contracts

Rules that keep three parallel streams mergeable. Per-surface UI/API contracts live in
[`contracts/`](contracts/); this file indexes them and states the cross-stream rules.

## 1. Domain ↔ Foundation

- Domains consume the runtime only through `@aptamind/workflow-sdk` (capabilities, specs, service
  tokens) and infrastructure packages listed for them in `scripts/check-architecture.ts`.
- A new domain package is added beside `market` in the `DOMAIN` set; domains never import each
  other (enforced by `pnpm check:arch`).
- Collections are prefixed by domain (`market_*`, `professional_*`) and declared through the
  existing collection-spec/migration mechanism in `@aptamind/db`.
- Capability ids are namespaced (`market.*`, `professional.*`); generic ones stay `core.*`.

## 2. Domain ↔ API

- Each domain contributes its own route module to `apps/admin/lib/api-server/routes/`. Existing Market and
  runtime routes stay at their current `/api/*` paths (e.g. `/api/companies`, `/api/jobs`,
  `/api/sources`, `/api/review`, `/api/runs`) — no renames. New Professional routes live under
  `/api/professional/*`.
- Request/response schemas are zod-validated server-side (ADR-0018). Every mutation takes the
  `Actor` from the request-context seam (ADR-0008).
- List endpoints intended for Admin record views support server-side pagination (cursor or
  limit/offset), sorting and filtering on the fields the contract names; the browser never loads a
  whole collection.

## 3. Domain ↔ Admin UX

- A domain stream publishes `contracts/<domain>-<surface>.md` before or with the API change.
- Admin renders canonical values, their provenance, confidence and conflict state exactly as the
  API returns them. The API returns display-ready enums plus, via `GET /api/meta/enums`, default
  labels and must-not-blur descriptions; the UI owns presentation and layout and may shorten a
  label but never change its meaning.
- If an Admin surface waits on a missing endpoint, Admin records the dependency in
  `PROGRAMME_STATE.yaml` and continues with another milestone.

- **Summary convention (cross-domain).** List/peek projections render every canonical fact as a
  `SummaryFact`: `value`, `status` (`known | unknown | conflicting`, plus domain-specific states such
  as `expired`), `confidence {level, score}`, `basis` (primary reason) and `alternates` (count of
  lower-authority values). Unknown/conflicting are never collapsed into a bare value. Market
  defines it first (`packages/market/src/api/summary.ts`); Professional read APIs (API-P1) use the
  same shape so Admin renders both with one property system. Summaries carry `rev`/`contentHash`
  (and interpretation/policy versions where relevant) for version-pinned joins. `factsHash`
  (sha-256 over each summary fact's value, status, confidence — Professional adds `basis`) is the
  summary-row pin; it detects drift but does not retrieve old versions.
- Enum filters match the fact's `value` regardless of status; callers wanting settled values add
  `hasConflicts=false` / `minConfidence`.

## 4. Professional ↔ future Opportunity Intelligence

- Canonical professional profile and career targets are addressable by stable ids and versioned, so
  a future join can reference the exact version it scored.
- Professional stores capability evidence (skills, experience, achievements) separately from
  viability facts (work authorization, location, relocation, mobility); fit must never read
  viability facts.
- Market employment intelligence (remote scope, sponsorship, authorization) stays a Market fact
  with its evidence hierarchy; Opportunity will combine it with Professional viability facts.

## 5. Foundation Exceptions

A stream that needs a frozen package changed writes
`foundation-exceptions/<id>.md` (problem, why stream-local is insufficient, affected packages,
proposed change, compatibility, migration, tests, alternatives), then an isolated PR that runs the
full Foundation regression, architecture gate and an independent review, and is checked against
Market, Professional and Admin. Index:

| Id    | Title                                                                                 | Status          |
| ----- | ------------------------------------------------------------------------------------- | --------------- |
| FE-P6 | Generic artifact route refuses Professional artifacts                                 | Merged (PR #16) |
| FE-1  | `@aptamind/db` index sync misreads text indexes; drop race (record ships with PR #13) | Merged (PR #13) |

## Contract index

Market: [`market-provenance`](contracts/market-provenance.md) · [`market-companies`](contracts/market-companies.md) · [`market-jobs`](contracts/market-jobs.md) · [`market-sources`](contracts/market-sources.md) · [`market-review`](contracts/market-review.md) · [`market-runs`](contracts/market-runs.md) · [`market-dashboard`](contracts/market-dashboard.md). Professional: [`professional-subject-list`](contracts/professional-subject-list.md) · [`professional-subject-detail`](contracts/professional-subject-detail.md) · [`professional-source-detail`](contracts/professional-source-detail.md) (PR #24) · [`professional-career-targets`](contracts/professional-career-targets.md) (PR #26); later ones per `streams/professional.md`. Market (PR #22): [`market-enums`](contracts/market-enums.md).
