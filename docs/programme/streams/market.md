# Stream A — Market Intelligence: audit and M6+ plan

Branch `market/next` from the frozen Foundation `d9799b6` (`foundation-v0.1`). Owner: Market
stream. Ownership rules: [`../STREAM_OWNERSHIP.md`](../STREAM_OWNERSHIP.md) (on the supervisor
branch). Admin-facing contracts: [`../contracts/market-*.md`](../contracts/): `market-provenance` (shared conventions and Fact semantics), `market-companies`, `market-jobs`, `market-sources`, `market-review`, `market-runs`, `market-dashboard`, `market-enums`.

## 1. Baseline (2026-09-29, this worktree, Docker Compose infra)

| Check              | Result                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `pnpm test`        | 616 passed, 47 files                                                                          |
| `pnpm eval:golden` | 78/78: company resolution 12, job resolution 7, lifecycle 11, reconciliation 4, employment 44 |
| `pnpm smoke:live`  | GOV.UK, Greenhouse, Ashby, Lever: **NOT REACHABLE** (egress 403). No live verification yet.   |

## 2. Current-state audit

**Real** (exercised against real local services): the runtime, Mongo/Redis/S3, headless Chromium,
all Market persistence, resolution, reconciliation (revision-fenced), lifecycle, verification
plumbing, the review queue with its durable operation, and source health. **Fixture only**: every
external source. That covers the UK register (gov.uk), the Greenhouse/Lever/Ashby APIs (the fixtures
are hand-written from documented shapes, not recordings), the aggregator feed (synthetic) and the
AI provider. **Stub or seam only**: signals, `organization.*`, `classification.schemes`,
firmographics, `hiringCountries`, `eorIndicators` and company `remotePolicy`/`relocationSupport`.
Only the demo seed's directory source writes these fields. No productised source populates them.

### 2.1 Source coverage and company universe (the biggest gap)

- The only productised company universe source is the UK sponsor register. Its rows have **no
  domain or website**. The domains in the demo come from a seed-only "company directory" source
  (`apps/worker/src/seed.ts`). On a real universe, careers discovery therefore returns
  `website_unknown` for almost every company, so coverage is capped at zero before any ATS work.
- There is no productised CSV or directory import for companies (with domain, careers URL, IDs) and
  no import for known ATS boards. There is no second public sponsor dataset and no domain
  enrichment source.
- Measurement is missing. No read model shows the funnel universe → domain → careers found → ATS
  detected → job source → live jobs, or how parse warnings split by provider. So sources cannot yet
  be ranked by coverage × quality.

### 2.2 Careers discovery and ATS detection

- Detection covers three families: Greenhouse, Lever and Ashby (URLs, embeds, `Grnhse` settings).
  Workable, SmartRecruiters, Recruitee, Personio, Teamtailor and Workday are neither detected nor
  counted.
- **Bug: EU hosts.** `boards.eu.greenhouse.io` and `jobs.eu.lever.co` are detected, but the region is
  dropped. Registration (`register_job_source`), fetch (adapter default) and verification all
  target the US API hosts.
- **Policy gap.** Every detection, including `low` confidence, is registered as a scheduled
  source. `careers_page` sources are never auto-registered, because the workflow iterates only the
  ATS detections. The status `found` can rest on an unfetched link candidate.
- Discovery is HTTP-only: JS-rendered homepages and off-site careers hosts are missed. No outcome
  reason codes are recorded.

### 2.3 Acquisition and job ingestion

- **Bug: partial parse becomes absence.** Adapters drop malformed or unlisted entries with only a
  warning, and the listing stays `complete: true`. The dropped external IDs are missing from `seen`,
  so a job whose entry turns malformed goes `POSSIBLY_STALE` and then `CLOSED`
  (`fetch_job_board` → `finalize_job_listing`). Warnings are logged only; no review is raised.
- **No shrink guard for job listings.** Only an empty listing after a non-empty one is caught. The
  sponsor register has a >50 % guard; an ATS board that drops from 200 to 5 jobs does not.
- Greenhouse maps only `location.name` and ignores `offices[]`, so multi-location data is lost.
  The fixtures put `pay_input_ranges` in the listing response; the live listing shape is
  unconfirmed. Payloads from verification fetches are discarded, not ingested. No adapter captures
  application questions.
- There is no recorded live fixture and no drift detection.

### 2.4 Lifecycle and freshness

- Ashby verification fetches the whole board once per job. Nothing is coalesced with a fresh
  listing.
- `careers_page` sources are never complete. Their jobs close only on a 404 from the posting URL,
  so `POSSIBLY_STALE` accumulates without bound. JSON-LD `validThrough` is ignored.
- There is no backoff for failing sources, no handling of a board that was removed, and no
  schedule jitter. Rate limiting is per process.

### 2.5 Employment intelligence (probed with `interpretJob`; see M11.1)

- Status values separate the role statement from company capability (`explicit_*` vs
  `company_capable`/`historical_evidence`). There is no explicit evidence tier for **application
  constraints**, **official company policy** or **hiring history**.
- `historical_evidence` is derived from _lapsed licences_. That is past capability, not hiring
  history.
- **Company capability leaks.** When the job's countries are unknown (plain "Remote", or no
  location), a UK licence still yields `company_capable` (low). "Unknown stays unknown" says it
  should be `unclear`, with the capability recorded.
- "You must have the right to work in the UK" plus a licence gives `company_capable` (medium) with
  no tension flag. "Visa assistance" is not recognised. "Must not require sponsorship now or in the
  future" gives `explicit_no`, but `authorization.required` stays null. Authorization has no
  `regions` field, so "eligible to work in an EU country" yields countries `[]`.
- **Bug.** The `market.interpret_job` inspection capability builds its own input (no department,
  `historicalSponsorshipCountries: []`, `hqCountry: null`), so it can disagree with canonical
  reconciliation.

### 2.6 Evaluation coverage

The 44 employment goldens split as: work model/remote about 20, compensation 17, sponsorship 3,
relocation 2, requirements 1, "unknown" 1, authorization 0 dedicated. No golden covers ATS or
careers detection, adapter end-to-end mapping, licence reconciliation, or listing edge cases
(malformed entry, shrink). Nothing turns operator corrections into regressions.

### 2.7 Operator review and API

- `careers_discovery` reviews cannot be acted on. They allow `confirm`/`dismiss` and support only
  `retry`, so an operator cannot choose a board, reject one, or merge the companies behind a shared
  board.
- `employment_conflict` does not name the correctable field or its current value.
- An ambiguous `$` raises one review per job, which floods the queue at scale. There is no
  grouping or bulk action.
- List endpoints return full documents (companies include licences and evidence). Sort order is
  fixed. Filters are unvalidated strings, so a bad enum returns an empty page instead of a 400. `q`
  is an unanchored regex (collection scan). The frozen `pageQuerySchema` caps the offset at 100k,
  while the UK register alone is about 10^5 organisations.
- The job detail endpoint does not follow merges. No company or job run history is exposed. Route
  tests cover only health, sources, runs, dashboard and 404/400; there are no response-schema
  tests.

## 3. Plan: M6–M12 as a PR DAG

Every PR is small and independently reviewable, ships its tests, docs and golden additions, and
changes no frozen package. New collections, indexes and routes are additive registrations in the
composition layer. **Net**: `F` = fixture-only (CI-safe); `L` = needs live network, to record
fixtures or validate. CI stays fixture-only, and live checks never gate CI. **Contract**: the Admin
contract the PR publishes or updates.

### M6 — Acquisition correctness and measurement (F)

| PR   | Goal / scope                                                                                                                                                                                                                                                                                      | Acceptance and tests                                                                                                                                        | Deps | Contract                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------- |
| M6.1 | Partial parse is never absence. `AdapterListing.skipped[]` (external ID + reason) in `connectors/*`, `fetch_job_board@2` output, `finalize_job_listing@2` treats skipped IDs as seen. Skip ratio > 10 % ⇒ incomplete. Warnings ⇒ `parser_failure` (low, counts + sample). Templates bump version. | Unit tests per adapter. Int: a malformed entry keeps the job `VERIFIED_LIVE`. Golden lifecycle `malformed-entry-not-absence`, `unlisted-entry-not-absence`. | —    | market-sources (warnings) |
| M6.2 | Shrink guard for job listings: a complete listing with < 50 % of `lastItemCount` (and a drop of ≥ 10) applies no absences and raises `source_anomaly`. Mirrors the register guard.                                                                                                                | Int: 200→5 closes nothing, review raised. The next normal listing proceeds. Golden lifecycle `listing-shrink-held`.                                         | M6.1 | market-review (type)      |
| M6.3 | Regional ATS hosts end to end: detection returns `apiBase`, registration stores `endpoint.url`, fetch and verification use the source endpoint. Adapters take an optional base.                                                                                                                   | `ats-detect`, register and verification tests for GH-EU and Lever-EU. Existing US paths unchanged.                                                          | —    | —                         |
| M6.4 | One interpretation input: `market.interpret_job` reuses the reconciler's `interpretationInput`.                                                                                                                                                                                                   | Test: `interpret_job` output = reconciled facts for every fixture job.                                                                                      | —    | —                         |
| M6.5 | Coverage funnel read model plus `GET /api/metrics/coverage`: universe → domain → careers status → ATS detected (by provider) → job sources (by health) → companies with ≥ 1 live job; parse-warning rate per provider.                                                                            | Int test on seeded fixtures with exact counts. Uses indexes (explain test).                                                                                 | —    | market-dashboard (new)    |

### M7 — Admin-ready Market API (F; Market-owned API work behind the contracts)

Status (branch `market/api-lane`): M7.1–M7.5 implemented, one commit each, contracts updated in
the same commits (`market-provenance` list v2 conventions; `market-companies`, `market-jobs`,
`market-sources`, `market-review`, `market-dashboard`). Deviations: active-job counts and
`hasActiveJobs`/`hasOpenReviews` are live index-backed semi-joins instead of a denormalised
counter (no writes in job/lifecycle paths); source runs page by offset (runtime-owned
collection); review claim/release/assign (API-9) is not part of M7.5.

PR #10 review fixes (same branch): job title search on title tokens (no text index); live
semi-joins driven from the small side; `escapeRegex` truncates before escaping; `supportedActions`
on the review detail and on the list only with `include=actions` (probes, bounded, per-item
degradation); `correctable[].current` and every summary fact follow the cross-domain `SummaryFact`
(`basis`, `alternates`); summaries carry `rev`/`contentHash` (jobs also the interpretation
versions) and live `openReviewCount`; summary row budget 3 KB (was 2 KB); source name-prefix
search (word prefixes, `nameTokens`); v1→v2 search changes documented as breaking; reference cursors for very long
sort values; `by_company_state` re-keyed status/state-first (the `hasActiveJobs` distinct was a
collection scan); `by_context_source` partial instead of sparse. Index sync itself (text indexes,
the IndexNotFound race) is Foundation Exception FE-1 (PR #13), not worked around here.

Branch `market/api-lane-2` (after PR #10 merged): **M7.6** record sub-resources, company/job
run history and the merged-job `survivor` (market-companies, market-jobs, market-runs);
re-review follow-ups — `factsHash` version pin on summaries (R1/R3), source search on name word
prefixes (R2), `count=exact` refused on the semi-join fallback, titles searchable from job
insertion, run-label indexes partial through one shared helper that builds before it drops (migration 2026-09-30-003); **API-9** advisory triage claims
(`POST /api/review/:id/{claim,release}`, holder = a client token in the body, stored hashed; the Idempotency-Key names one attempt; cooperative force-release; no assign in v0.1); **M7.7**
`GET /api/meta/enums` (market-enums).

Follow-ups recorded from the PR #10 reviews:

| Id    | Follow-up                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M11.x | **Resolved (PR #21, `job-policy/3`).** A `sponsorship` override decides only the role axis (`explicit_yes \| explicit_no \| unclear` with the matching `roleStatement`); the company axis is recomputed and its evidence kept; company-axis statuses are refused (400). Correcting a wrongly matched licence is a company-level follow-up (M11.5 / company review). |
| M7.x  | API-9 remainder: done on `market/api-lane-2` (claim/release). "Assign to another operator" waits for user identities (ADR-0008).                                                                                                                                                                                                                                    |
| M7.x  | Structured `appliesTo` in `GET /api/meta/enums` (typed response path / filter parameter pairs instead of free text); deferred by the PR #22 review (B-L6).                                                                                                                                                                                                          |
| M7.x  | **Tighten** the source name-search migration (widen → backfill → tighten; DECISION_LOG ruling): in a later release, re-run the `nameTokens` backfill (`migrateSourceNameTokens`), then unset `nameKey`, drop `by_name_key` and remove the `nameKey` search branch and writes.                                                                                       |
| M7.7  | Market enums endpoint (API-10): done on `market/api-lane-2` (`GET /api/meta/enums`, contract market-enums).                                                                                                                                                                                                                                                         |

| PR   | Goal / scope                                                                                                                                                                                                                                                                                    | Acceptance and tests                                                                               | Deps | Contract            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---- | ------------------- |
| M7.1 | Response DTO zod schemas (`packages/market/src/api/dto.ts`) for every list and detail. Route contract tests validate real responses. Enum filters become `z.enum` (400 on a bad value). Operator-override evidence uses the `system:operator` source id (it is the literal `'operator'` today). | Int: each endpoint's response parses. A bad enum returns 400. No change for existing Admin calls.  | —    | all market-* (v1.1) |
| M7.2 | Companies list v2: `view=summary`, `sort`, filters (`hasDomain`, `careersStatus[]`, `licenceStatus`, `hasActiveJobs`, `hasOpenReviews`, `sourceId`), indexed prefix search on name/alias/domain, keyset `cursor`. Uses a Market-local page schema, so the frozen 100k cap does not apply.       | Int: sort and cursor stability over 1k docs. Explain shows IXSCAN. Summary payload ≤ 2 KB per row. | M7.1 | market-companies    |
| M7.3 | Jobs list v2: summary view, `sort`, multi-value filters (state, workModel, remoteScope, sponsorship, relocation, `authorizationRequired`, `minConfidence`, `flag`, `verificationOutcome`, `salaryStatus`, `currency`, `minAnnual`, `sourceId`, `provider`), cursor.                             | As M7.2. The filter matrix is tested against fixture jobs.                                         | M7.1 | market-jobs         |
| M7.4 | Sources list v2: filters (provider, enabled, health[], `freshness=overdue`, companyId), sort, server-computed `freshnessState` (indexed; replaces the in-memory `overdueSources` scan), company name. Paginated `GET /api/sources/:id/runs` and `/snapshots`.                                   | Int tests. `freshnessState` has unit tests against the policies.                                   | M7.1 | market-sources      |
| M7.5 | Review queue v2: filters (type[], severity, entity kind, `resolving`, `hasFailure`, `scopeId`), sort, facets (counts by type and severity), server-computed `supportedActions` and `correctable[{field, current}]`. The detail includes job observations and the targeted fact.                 | Int tests. `supportedActions` always ⊆ what `resolve` accepts (property test).                     | M7.1 | market-review       |
| M7.6 | Entity activity: `GET /api/companies/:id/runs` and `/api/jobs/:id/runs` (labels plus observation `runId`s; no runtime change), merged-job `survivor` on the job detail, paginated observations with `current`/`superseded`.                                                                     | Int tests, including a merged job and a batch-discovered company.                                  | M7.1 | market-runs         |

### M8 — Company universe and careers discovery

| PR   | Goal / scope                                                                                                                                                                                                                                                            | Net | Acceptance and tests                                                                                                                            | Deps       | Contract                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------- |
| M8.1 | Company directory import `market.company_directory.import`: CSV upload, column map (name, domain, website, country, town, registry ids, careers URL) → per-row capability under `for_each`, strict reader (accepted). `third_party`. Ambiguity/bare names → review.     | F   | Int: idempotent re-import. A domain conflict becomes a fact conflict, not an overwrite. Golden resolution: `directory-domain-vs-register-name`. | M6.5       | market-sources (provider) |
| M8.2 | Known-board import: CSV of provider/token/company (name or domain) → resolve the company → `register_job_source`. An unresolved company → review; nothing is registered.                                                                                                | F   | Int: idempotent; a board owned by another company raises a review.                                                                              | M6.3       | market-sources            |
| M8.3 | Domain enrichment from Wikidata (P856 official website; CC0): match on name + country + register ID. Writes `third_party` observations at medium confidence. Multiple candidates → `unknown` plus a review, never a guess.                                              | L   | Recorded SPARQL fixtures. Golden: `wikidata-homonym-stays-unknown`, `wikidata-id-match`. Coverage delta reported.                               | M8.1       | —                         |
| M8.4 | **Implemented (branch `market/m8-4-registers`, see M8.4 status).** Second public sponsor register (NL IND recognised sponsors). Generalises the register provider (register ID, route taxonomy per register). Semantics unchanged: capability only, anomaly guard.      | L   | Recorded fixture. Int: delisting and anomaly guard. Golden reconciliation: `nl-licence-not-uk-role`.                                            | —          | market-companies          |
| M8.5 | Discovery policy and reason codes: auto-register only `high`/`medium`; `low` → actionable review. Register `careers_page` when there is no ATS but JSON-LD or job links exist. Record outcome `reason` (no_homepage, non_html, no_link, offsite_host, js_suspected, …). | F   | Discovery goldens (html → expected outcome) for 8 fixture sites. The funnel shows reasons.                                                      | M6.3, M6.5 | market-companies          |
| M8.6 | Discovery reach: browser fallback (existing `BROWSER` token, same egress proxy) when a JS shell is suspected; detect-only on off-site careers hosts.                                                                                                                    | F   | Browser int test on local pages. SSRF and scope tests unchanged and green.                                                                      | M8.5       | —                         |
| M8.7 | Actionable `careers_discovery` reviews: `confirm` a board (register/enable), `reject` a board (disable plus operator observation), `merge` the companies behind a shared board, all through the fenced review path.                                                     | F   | `review-resolution.int` cases for each action, crash/replay included.                                                                           | M8.5, M7.5 | market-review             |

**M8.1 status (branch `market/m8-csv-import`, from `main`; no dependency on M6/M11 code).**
Provider `company_directory`, workflow `market.company_directory.import` (contract:
market-sources § Company directory CSV). Decisions within the plan:

- Rows run through a per-row capability (`market.process_directory_row`, the company pipeline:
  observe → resolve → reconcile) in a bounded `core.for_each`, like the sponsor import, not the
  `process_candidate` subworkflow (one child run per row does not scale to 50 000 rows; the
  semantics are the same).
- The CSV is read by a strict RFC 4180 reader in the provider (not `core.parse_csv`, which
  relaxes quotes and column counts): a malformed row is reported, never imported with shifted
  columns, and row numbers are file lines.
- Checks before storage in `uploadSnapshot` (size, rows, company-only header; personal-data and
  unmapped columns refused). Directory sources are upload-only so no file bypasses them.
- No schema change (existing company observation payload), so widen → backfill → tighten does
  not apply. The M6.5 dependency is reporting only (import report as a review + artifact).
- Tests: `company-directory.test.ts` (reader, checks, mapping), `company-directory.int.test.ts`
  (import with provenance, idempotent re-import, domain conflict as a fact conflict, refusals
  before storage, upload-only). Goldens `directory-domain-vs-register-name`,
  `directory-domain-owned-by-other-company`, `directory-bare-person-name-no-town`,
  `directory-bare-person-name-no-match`.
- Both deviations above (per-row capability under `core.for_each`, not the `process_candidate`
  subworkflow; the strict domain reader, not `core.parse_csv`) were accepted in DECISION_LOG
  "Company directory imports" (PR #27 review), with the rulings on authority (`third_party`
  default), the external-id namespace registry and bare names.
- Follow-ups (not in M8.1):
  - **Retraction path:** a directory never delists, and there is no way yet to withdraw a
    directory's rows (a wrong file stays evidence until a later file changes the values). Plan: an
    operator action that retracts a source's (or a snapshot's) company observations, removes their
    evidence and re-reconciles the affected companies, audited, history kept.
  - **Declared as-of date:** freshness and observation source time are the upload/processing
    time; an upload cannot yet declare the date its data is from (`asOf`, validated not in the
    future, carried as the snapshot's source time into `sourceObservedAt`). Until then
    reprocessing an old snapshot counts as a fresh success.
  - An upload refused by the streaming size cap (body over `maxBytes`) is not audited (the body is
    never read); the checked refusals are.
  - **Company change detection gap:** `canonicalContent` (the reconciliation content hash behind
    `lastChangedAt`) does not include `identity.externalIds` or `quality.conflictFields`, so a
    register-id change or a recorded id conflict alone does not move `lastChangedAt` (PR #27
    re-verification #5, recorded, not done).
  - **Operator merge and aliases:** after an operator `merge` of a directory review, the merged
    row's name becomes an alias of the company; alias-only hits then go to review (condition d),
    so the next import of the same row reviews again. Needs an operator-confirmed alias path.
  - **Supersede records absent from a full directory re-import:** a directory never delists, so a
    row removed from (or re-keyed in) a later full file stays as current evidence; correcting a
    register id by re-import works only with an id column. Plan: an explicit "full re-import"
    mode that supersedes the source's records absent from the new file (PR #27 re-verification
    #6).
  - **Release stale `ext:` keys without waiting for the holder's next reconciliation:** a stale
    key is released only when that company is reconciled; when a record's newer version resolves
    to another company (or stays in review, or is dismissed) the older holder keeps the key until
    something reconciles it. Plan: when a newer version of a record resolves elsewhere, enqueue a
    reconciliation of the company its older version was linked to (PR #27 re-verification #8,
    L-2).

### M9 — ATS coverage by measured demand

| PR   | Goal / scope                                                                                                                                                                                                                                                     | Net | Acceptance and tests                                                                           | Deps       | Contract         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------------------------------------------- | ---------- | ---------------- |
| M9.1 | Detect-only families (Workable, SmartRecruiters, Recruitee, Personio, Teamtailor, Workday, BambooHR). `DETECTED_ATS_PROVIDERS` ⊃ `ATS_PROVIDERS` (ingestable); the company `ats` fact carries `supported`. Validator migration. Funnel by family.                | F   | Detection unit tests and goldens. Existing `atsRefSchema` documents still validate.            | M8.5       | market-companies |
| M9.2 | Adapter #1, the highest measured family with a documented, ToS-compatible public API (expected: SmartRecruiters or Workable). Pure adapter, completeness semantics, verification. Workday stays deferred (no documented public API; use the careers-page crawl). | L   | Recorded fixtures. Adapter goldens (raw → payload → interpretation). Int refresh plus absence. | M9.1, M6.1 | market-sources   |
| M9.3 | Adapter #2 (next family by coverage).                                                                                                                                                                                                                            | L   | As M9.2.                                                                                       | M9.2       | market-sources   |

### M10 — Lifecycle, freshness and live reliability

| PR    | Goal / scope                                                                                                                                                                                                                                        | Net | Acceptance and tests                                                                                   | Deps  | Contract         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------ | ----- | ---------------- |
| M10.1 | Live fixture recorder (`packages/market` script; read-only; sanitised) plus a drift detector: unknown or missing provider keys → `parser_failure` with a key diff. Settles the GH listing-pay and offices questions and adds `offices[]` locations. | L   | Recorded fixtures committed. A drift unit test on a mutated fixture.                                   | M6.1  | market-review    |
| M10.2 | Verification coalescing: a job present in a complete listing applied within the window counts as verified by the listing. Ashby: one board fetch per sweep per board. Verification payloads are ingested as observations.                           | F   | Int: N Ashby jobs → 1 fetch. Lifecycle goldens unchanged.                                              | M6.3  | market-jobs      |
| M10.3 | Source backoff and board removal: failing sources back off (×2, capped at 24 h). Repeated terminal 404 on a board → `source_anomaly` "board removed?" with no closures. Schedule jitter.                                                            | F   | Int with a fixture server. `ack-replay` stats unchanged.                                               | M6.2  | market-sources   |
| M10.4 | Careers-page lifecycle: JSON-LD `validThrough`, posting-URL `not_found`, and surfaced ageing for never-complete sources.                                                                                                                            | F   | Golden lifecycle: `validthrough-expired`, `careers-page-absence-ignored`.                              | —     | market-jobs      |
| M10.5 | Live canary workflow plus a dashboard panel: known boards, read-only; classifies egress, provider-shape and empty-board outcomes.                                                                                                                   | L   | Runs green where egress is allowed. Unreachable is reported, never counted as a failure of the source. | M10.1 | market-dashboard |

### M11 — Employment intelligence: the evidence hierarchy

Order: role explicit statement > application constraint > official company policy > company
capability > hiring history > inference. Company capability never becomes a role `explicit_*`.
Unknown stays unknown.

| PR    | Goal / scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Net | Acceptance and tests                                                                                                                                                                                                                      | Deps         | Contract                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------- |
| M11.1 | Semantics fixes from the §2.5 probes (policy bump). Unknown job countries with a licence → `unclear` + capability recorded. Right-to-work requirement with capability → info flag and low confidence. "Visa assistance/support" is recognised. "Not require sponsorship now or in future" → `authorization.required`. Authorization gains `regions`.                                                                                                                                                                                                                                                                                                                                                         | F   | Goldens: `capability-unknown-job-country`, `rtw-required-with-licence`, `visa-assistance-positive`, `no-sponsorship-future-implies-auth`, `eu-work-eligibility-region`. All earlier goldens still pass. Owner sign-off on the first case. | M6.4         | market-jobs                   |
| M11.2 | Evidence-tier model: `basisTier` plus a per-tier `ladder[]` on sponsorship, authorization and relocation. A mapping table from tier to the statuses it may produce. Reinterpret migration (logic version bump; `market.job.reinterpret` over active jobs).                                                                                                                                                                                                                                                                                                                                                                                                                                                   | F   | Unit test: capability and history tiers can never emit `explicit_*`. All goldens updated to assert `basisTier`.                                                                                                                           | M11.1        | market-jobs                   |
| M11.3 | Application constraints: Greenhouse `?questions=true` on content change only; sponsorship and authorization questions become `application_constraint` evidence. A screening question alone does not decide a status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | L   | Recorded fixtures. Goldens: `screening-question-not-no`, `question-states-no-sponsorship`.                                                                                                                                                | M11.2, M10.1 | market-jobs                   |
| M11.4 | Official company policy: careers-page statements (sponsorship, relocation, remote) → company `employment.*.policy` facts (official_site), separate from capability; `company_policy` tier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | F   | Goldens: `policy-yes-role-silent`, `role-no-overrides-policy-yes`.                                                                                                                                                                        | M11.2, M8.5  | market-companies, market-jobs |
| M11.5 | **Partly implemented (branch `market/m11-5-h1b`, see M11.5 status): US H-1B Employer Data Hub history adapter done; DOL LCA disclosures remain.** Hiring history: public US DOL LCA disclosures (upload or download) → company sponsorship `history` facts; `hiring_history` tier. The lapsed-licence relabel (`previously_licensed`, capability, not history) and its golden `lapsed-licence-not-history` are **done in M11.1**. Also: a lapsed GB licence is dropped from the evidence when the company is currently licensed in another country (e.g. IE) — keep both (PR #21 L6); company-level correction of a wrongly matched licence. Attach only on a high-confidence match; never create companies. | L   | Dataset int test on a sample. Goldens: `lca-history-not-role-yes`, `lapsed-licence-not-history`.                                                                                                                                          | M11.2, M8.1  | market-companies, market-jobs |

### M12 — Evaluation and operator loop (F)

| PR    | Goal / scope                                                                                                                                                                                                                     | Acceptance and tests                                                                                   | Deps | Contract          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---- | ----------------- |
| M12.1 | Golden expansion plus a per-dimension report (`eval:golden --json`): adapter end-to-end, ATS/careers detection, licence reconciliation, listing edge cases, authorization. A minimum case count per dimension is enforced in CI. | At least 30 new cases. The report artifact is written by CI.                                           | —    | —                 |
| M12.2 | Review → golden candidate: resolving a `correct` on a job semantic field writes a redacted golden candidate (observation text, input, operator value) through `golden:from-review`.                                              | Int: a correction yields a candidate file that fails on current logic, or is marked "already passing". | M7.5 | market-review     |
| M12.3 | Review grouping and bulk resolve: `groupKey` (flag code × company or source), `POST /api/review/bulk-resolve` = N independent durable operations with per-item results.                                                          | Int: partial failure is reported per item. B-3 suite green.                                            | M7.5 | market-review     |
| M12.4 | `GET /api/{companies,jobs}/:id/explain?field=`: dry-run reconciliation trace (candidates, authority, confidence, recency, selection, conflicts, interpretation basis and spans, versions). Market-local, no provenance change.   | Unit tests: the trace's winner equals the stored fact for every fixture field.                         | M7.1 | market-provenance |

### DAG and waves

```text
M6.1 ─► M6.2 ─► M10.3        M6.3 ─► M8.2, M10.2, M8.5     M6.4 ─► M11.1 ─► M11.2 ─► M11.3/M11.4/M11.5
M6.5 ─► M8.1 ─► M8.3, M11.5  M6.5 + M6.3 ─► M8.5 ─► M8.6, M8.7, M9.1 ─► M9.2 ─► M9.3
M6.1 ─► M10.1 ─► M10.5, M11.3                    M7.1 ─► M7.2..M7.6, M12.4;  M7.5 ─► M8.7, M12.2, M12.3
M12.1 (independent; start in wave 2)             M10.4, M8.4 (independent)
```

Wave 2: M6._, M7.1–M7.5, M12.1. Wave 3: M8.1–M8.5, M10.1–M10.3, M7.6. Wave 4: M11._, M9.*, M8.6–M8.7,
M10.4–M10.5, M12.2–M12.4. Coverage PRs (M8.1, M8.2, M8.4) can move earlier: each depends only on
M6.3 or M6.5.

## 4. Foundation Exception candidates (none needed now; stream-local first)

| Candidate                                                       | Trigger                                                              | Stream-local alternative (preferred)                                                                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-process per-host rate limiting in `@aptamind/net`         | The live canary shows 429s or politeness breaches with > 1 io worker | One dedicated `io` worker for ATS hosts, schedule jitter, per-source intervals (M10.3)                                                                                                |
| Generic `core.parse_xlsx` node (`workflow-nodes`)               | DOL LCA and other XLSX-only public datasets (M11.5)                  | A Market-local parse capability, or an operator CSV upload                                                                                                                            |
| `taxonomy` additions (SOC occupation codes; any missing region) | M11.5 occupation matching; M11.1 authorization regions               | Keep raw codes in Market, map later. Existing taxonomy regions already cover EU/EEA.                                                                                                  |
| Not an exception                                                | —                                                                    | Offset cap (Market-local cursor schema), explain trace (Market dry run), browser in discovery (the `BROWSER` token is already allowed), run history (labels plus observation `runId`) |

Additive registrations (routes, collections, indexes, migrations, CI steps) stay within the
composition-layer rule and are not exceptions.

## Supervisor review (Wave 1)

- Accepted. The M7.x list/detail APIs satisfy the Admin asks API-1–API-5 and API-9
  (`streams/admin-ux.md` §5); Market publishes each changed contract with the PR that changes it.
- M11.1 "licence + unknown job country → `unclear` (capability still recorded)" is **approved
  without owner escalation**: it applies the owner's standing rules "unknown remains unknown" and
  "company sponsorship capability is not role sponsorship". Logged in `DECISION_LOG.md`.
- Live (`L`) items: this cloud environment's egress policy blocks GOV.UK and ATS hosts (403), so
  `L` PRs ship fixture-verified with a recorder/canary and are live-validated when an environment
  with that egress is available. Not a blocker for `F` work.
- Execution: two parallel Market lanes — acquisition/semantics (M6.1–M6.4, then M11.1) and API
  (M7.1 → M7.2–M7.5) — with disjoint files; M6.5 after M7.1.

## 5. M6 (PR #11): accepted exceptions, status and deferrals

### In-place changes to published `@1` capabilities (accepted by the supervisor, A-M2/B-M1)

The rule is "new behaviour = new capability version". PR #11 changed six published `@1`
capabilities in place, and M6.2 four more (additive, opt-in or bookkeeping only; accepted by the
supervisor in the M6.2 review, M-1). Each keeps its input contract or extends it additively; each change is a
correctness fix that runs pinned to older template versions should also get. Each description says
"Changed in place in PR #11" (or "in M6.2"); `pnpm docs:capabilities` lists them under "Versions changed in
place".

| Capability                                | In-place change                                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `market.fetch_job_board@1`                | Any skipped entry makes the listing incomplete (M6.1). `@2` reports `skipped[]` instead.                                                                                                                 |
| `market.finalize_job_listing@1`           | The M6.2 shrink guard (per-baseline `source_anomaly`, held listing = successful fetch) replaces the empty-listing guard; small boards that empty are held one run (L2).                                  |
| `market.discover_careers@1`               | Detections carry the regional `apiBase` (M6.3; additive output).                                                                                                                                         |
| `market.register_job_source@1`            | Optional `apiBase` input; regional boards get a `provider:region:token` key (M6.3).                                                                                                                      |
| `market.verify_job@1`                     | Verifies on the copy's source endpoint (regional hosts, M6.3; the default host without one, E1). An Ashby `not_found` needs positive proof of absence (A-H1) on a board that is not a shrink (L1).       |
| `market.interpret_job@1`                  | Uses the reconciler's interpretation input (M6.4).                                                                                                                                                       |
| `market.reconcile_job@1` (M6.2)           | Optional config `recordRunChange` (default `false`; set by `market.jobs.reinterpret_outdated`) records a `job.reinterpreted` audit event linked to the run when the job changes (MR2). Additive, opt-in. |
| `market.recompute_source_jobs@1` (M6.2)   | Each job it changes gets a deterministic `job.lifecycle_rederived` audit event linked to the run (MR2). Additive.                                                                                        |
| `market.sweep_recorded_evidence@1` (M6.2) | Same audit event per changed job (MR2); a recovered job leaves the retry list only once its `lifecycle_failure` review is dismissed (L1); the retry phase is capped at half the budget (L4).             |
| `market.freshness_sweep@1` (M6.2)         | Same audit event per job its stale sweep or resumed standing recomputes change (MR2). Additive.                                                                                                          |

Orphaned reviews: the old empty-listing guard raised `source_anomaly:<sourceId>:empty`, which
nothing reads any more. `MarketDomain.ensureReady` dismisses any such open item through the
normal, audited resolution operation, with a deterministic operation id. It is idempotent across
processes and restarts (`review/legacy-reviews.ts`).

### M6 status (PR #11, branch `market/m6-acquisition`)

| Item | Status                                                                                                                                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M6.1 | Done. Parser findings keyed by adapter version + malformed set (B-M4; system supersessions do not suppress, B LOW-2). Skipped entries advance `lastSeenAt`/`present` only (U1). 10 % over listed + malformed (A-L4).                                             |
| M6.2 | Done. Held listing = successful fetch + `health.listingHeld {reason, since, lastAt, …}`. Boards ≥ 10: shrink held with a review. Small boards that empty: held one run, no review (L2). Legacy baseline fallback (A-M1).                                         |
| M6.3 | Done, fixture-verified. **The EU hosts (`boards-api.eu.greenhouse.io`, `api.eu.lever.co`) are not verified live**: this environment's egress blocks ATS hosts. ATS sources always store their listing URL; without one, verification uses the default host (E1). |
| M6.4 | Done. `interpret_job` is the primary copy's interpretation before cross-copy conflicts and overrides (docs reworded).                                                                                                                                            |
| M6.5 | Not started (after M7.1).                                                                                                                                                                                                                                        |

Lifecycle rulings from the PR #11 re-review (supervisor, authoritative; `job-lifecycle/2`):

- **L1.** Absence alone never closes a job. An absence-driven close needs ≥ 2 consecutive
  absences and a `not_found` verification since the first of them; a `live` verification ends
  the run of absences. This replaces the earlier "per-job verification still gates closing"
  rationale, which was wrong: two absences used to close a job without any verification.
- **Board-derived reads (DECISION_LOG b7f1a76, third round; supersedes the earlier
  board-derived clauses).** An Ashby board read is the same evidence as a listing read, never
  independent verification. It only corroborates a job-level absence run: job-level
  `consecutiveAbsences ≥ 2` (not counted while another authoritative copy is present), no
  sighting or live verification since the first absence, no hold. An empty board also needs no
  positive evidence on the source since then, and a non-empty board must not be a shrink.
  Greenhouse and Lever single-job 404s are unchanged. A dead small Ashby board closes after
  hold → apply → apply → read. Integration: `board-evidence.int.test.ts` (V1, V1b, MC, M2 and
  one scenario per guard).
- **L2.** A small board (baseline < 10) that empties is held for one run without a review
  (`listingHeld.reason: small_board_empty`); the next consecutive empty listing is applied. A
  sighting or live verification on the source after the hold re-arms it (b7f1a76); only the held
  source's own copies and verifications against it count (a9af734 M2).
- **Apply fence completed (DECISION_LOG 0bcc357, fifth round).** `live` results are re-gated
  too (never reopen a job closed after the check); the timestamp rule uses authoritative evidence
  only, for direct 404s as well, and so does the board-derived run fence (a third-party sighting
  between check and apply no longer makes it inconclusive); copies on disabled or missing sources
  are never verified.
  Integration: a-2, c-2, d-1, d-2b, d-3 in `verification-races.int.test.ts`.
- **Apply fence and run evidence (DECISION_LOG a9af734, fourth round).** A board-derived
  `not_found` records the run fence (absentSince, lastSeenAt, lastVerifiedAt) at check time; at
  apply it becomes `inconclusive` if the fence moved, and any `not_found` does when the job was
  seen or verified at or after the check. Verification reads a present authoritative copy
  first, on that copy's own board; "absent from listings" is job-level. Run-resetting evidence is
  authoritative-tier only; an absence after positive evidence restarts the run. Integration:
  `verification-races.int.test.ts` (RACE-LIVE, RACE-SITE, RACE-SITE fence, RACE-SIGHTING,
  RACE-DIRECT, MC-DIRECT, RESTART-SKIPPED, HOLD-FOREVER); `verification-safety.int.test.ts` now
  starts each guard test from a real two-absence run and runs the control that closes the job.
- **U1.** Skipped or unlisted entries are seen, not verified. A provider-hidden job
  (`sourceRefs[].providerState: unlisted`, "hidden by provider") decays to `POSSIBLY_STALE` and
  stays there; it is never closed by absence. The job summary exposes it as
  `hiddenByProvider`.
- **E1.** No `endpoint.url` → verify on the adapter default host (where fetch got the jobs).
  Registration and `PATCH` store the listing URL.

Supervisor review of PR #11: A-H1, B-H1, A-M1, A-M2/B-M1, B-M2, B-M4, B-M5, the Low items, and
the re-review findings (A new High → L1; B NEW-HIGH-1 → U1; A N-M1–N-M3; A N-L1 / B LOW-1 → E1;
B LOW-2) are addressed on the branch, pending re-review.

### Deferred from the PR #11 review

- The operator merge of two jobs (`review.service.ts`, job_duplicate `merge`) moves the merged
  job's copies to the survivor but does not fold the merged job's lifecycle (absence run,
  `lastNotFoundAt`, verification times) into it (PR #11 re-verification #4 LOW) → follow-up with
  M6.5; not fixed on PR #11.
- Operator reminder or escalation for a listing held for a long time (`health.listingHeld.since`)
  → **M10.3** (source backoff and board removal).
- Semantics of review `occurrences` (per run, per raise, per refresh) → **M12.3** (review grouping
  and bulk resolve).
- Re-verify backoff, and an alternation review → **M10.2 / M10.4** (PR #11 re-review LOW-2). Under
  ruling L1, a job whose listing absence and a `live` single-job read keep alternating never
  closes: each `live` ends the run of absences. That is by design. It needs a backoff on
  re-verification, plus a review raised after N alternations so an operator decides.

### M11.1 status (branch `market/m11-semantics`)

Implemented, with a golden that failed first for each semantic bug. Logic
`job-interpretation-rules/2026-09-30.7`, policy `employment-policy/2026-09-30.7` (DECISION_LOG
012d041, v0.1 final — posting text never yields a sponsorship verdict; a structured line is a
statement, `sponsorship_stated`; verdicts come only from an operator assertion; title and
location are scanned for mentions; the gating corpus holds every reviewer's out-of-sample set;
completed by 8d96663 — key, separator and value on one line; stated values compared across all
present copies; an operator decision closes the question and stale conflict items are closed by
the system; a stated value does not suppress company evidence; flag `value` is `yes | no`).
**3dfe3c5 (PR #21 re-verify #9, narrows 8d96663):** a stated value is one text line `key
separator yes|no` (tables, other values and footnote markers are mentions; the table-cell rendering
is reverted); an operator decision (override, dismiss, confirm) records the decided stating set
(`job.sponsorshipDecision`) and suppresses the conflict only while the current set is a subset;
alternates are kept behind an override; a cross-copy "no" counts for company confidence; decided
reviews with unchanged evidence (`context.evidenceHash`) are not re-raised and CLOSED jobs raise
none; the backfill is step 3 of the Market deploy (drain → start new → run until done), with a
startup warning while outdated jobs remain and the `by_policy_version` index.
**a720377 (PR #21 re-verify #10):** statements are read from one canonical rendering — the
enrichment layout rendering of `descriptionHtml` whenever it exists (connector `descriptionText`
only without HTML; stored texts and connector renderers unchanged), any line holding
`table`/`tr`/`td`/`th` text is layout (stray fragments included), sponsorship evidence into it is
labelled `html_layout`; the corpus runs every case through the production input path too. Legacy
hashless closures re-ask once; merges keep a sponsorship decision; a sponsorship `correct` through
a field_conflict records one; a decision on an item never refreshed records nothing (asked again).
**5a13fed (PR #21 re-verify #11):** a statement line comes only from allowlisted, visible
plain-flow HTML (struck, hidden, ARIA-grid, `ins`, `mark`, links and unknown elements are
mentions; `mark` deliberately outside the list); layout matched by line start offset; tagless
`descriptionHtml` read as text; the corpus production path runs through the real aggregator
connector; review digests independent of the primary copy and of overrides (work-model digest
from the interpretation, anti-signal line included); re-asked items say why.
**7f01fe5 (PR #21 re-verify #12):** no CSS is interpreted — a statement line needs every
overlapping element (ancestors, descendants, empty or line-breaking boundary elements) to be an
allowlisted tag with no attribute but `lang`/`dir`; `<style>`/`<link>`/`<script>` anywhere
disables statements for the description; the HTML5 and lenient parse trees must agree; per-copy
work-model digests; any earlier matching decision suppresses; digests versioned (2); 200k cap
without a partial line; `№` is not "No".
**bc013e8 (PR #21 re-verify #13, passed with Mediums):** a closed set of inert editor styles
(`min-height:1.5em`, `font-weight`, `text-align`, `list-style-type` values) and the Greenhouse
wrapper classes are neutral, attribute-free `hr` too; realistic-editor recall reported separately
(corpus: 9/14, residuals Lever font-size, Quill ql-align, Google Docs colours, Word MsoNormal,
TinyMCE font-family); stated values keep their key scope (H-1B → US, …); refreshed items refresh
their evidence, and decisions accept an If-Match digest; work-model items follow any copy; readings
keyed by copy; the "asked again" suffix persists; exact-200k text keeps its last line.
**Re-verify #14 (passed; Medium + Lows fixed):** the review claim is a compare-and-set on the
If-Match digest (released with 409 on mismatch); without it the claim records the digest and
stating set it saw; conflict-item evidence is every stating line; stating keyed by copy + value;
scoped polarities; licence test scope ∩ licence ∩ job countries. **Admin follow-up:** send
`evidenceHash` on review decisions; the API then requires it (428) for job-reconciliation items.
**Final check (passed; Mediums and Lows fixed):** the claim is one CAS on the shown digest (a
leftover claim marker no longer blocks, "evidence changed" vs "not open" distinguished, hashless
items accept If-Match); the shown digest is stored on the operation and a resume/recovery applies
only on it; stating entries keyed by copy + value + scope + stated line.
**Residual bar:** deliberately constructed HTML beyond these rules is Low (stated values are never
verdicts and are shown as unverified quotes). A plain-text-only copy (no HTML) is read as text.
(The CSS `display: table` residual is gone: any `style` attribute takes the line out.)
**Admin follow-up (not Market's):** the review result `{"applied":false,"askAgain":true}` is shown
as raw JSON (`apps/admin/lib/actions.ts`); it should read "asked again".
**Follow-ups (not fixed on PR #21):** L-a — a listing absence sets `present: false` without
reconciling, so a `sponsorship_conflict` flag, its alternates and its open item stay until the
job's next reconciliation → M6.5 (reconcile on absence); L-b — reviews are raised after the fenced
write, and reconcile writes do not move `rev`, so an older concurrent reconcile can raise an item a
newer one just closed; fencing the raise needs a derived-write revision → M12.3 (review raise
fencing).
**Backfill (8d96663 (3)):** implemented as the Market workflow `market.jobs.reinterpret_outdated`
(select → `core.for_each` over `market.reconcile_job` → report), run by the deploy runbook
(`docs/runbooks/reprocessing.md`), not as a platform migration: it needs the whole Market domain
and can run for minutes, so no migration entry (2026-09-30-006 unused). The evidence
hierarchy is unchanged (role statement > application constraint > company policy > company
capability > hiring history > inference), and unknown stays unknown.

- A licence with unknown job countries is `unclear`, with the capability recorded (DECISION_LOG
  2026-09-29): `capability-unknown-job-country`, `capability-no-job-location`.
- A right-to-work requirement with a licence stays `company_capable` at low confidence, with a
  flag: `rtw-required-with-licence`.
- Free text (including "visa assistance / support") is a mention, never a polarity (9186ad2):
  `visa-assistance-positive`, `visa-support-available`, `negative-assistance-*`,
  `explicit-yes-sponsorship`, `explicit-no-sponsorship`; structured lines are statements (`sponsorship_stated`), never verdicts:
  `structured-no-overrides-licence`, `structured-yes-withheld-by-restriction`, `blue-card-dk`, `blue-card-de`;
  a stated value leaves the status to the company axis (8d96663 (5)): `structured-yes-lapsed-licence`,
  `structured-no-licence-other-country`.
- **Future work (not v0.1):** free-text sponsorship recall via schema-validated AI proposals
  (provider/model/prompt-version metadata, deterministic policy decides), accepted only if they
  pass the same out-of-sample gating corpus (0 wrong polarity).
- "Must not require sponsorship now or in the future" sets `authorization.required`:
  `no-sponsorship-future-implies-auth`.
- Region-level authorization (`authorization.regions`, e.g. `EU`): `eu-work-eligibility-region`.
- A lapsed licence is past capability (`previously_licensed`, `unclear`), not hiring history:
  `lapsed-licence-not-history`, plus the two M6.4 stored-copy goldens.
- PR #10 follow-up B-L2: a sponsorship override freezes only `status` and `roleStatement`; the
  company axis is recomputed: `sponsorship-override-keeps-company-axis`.
- PR #21 review: visa-assistance offers only to the candidate/role, their negatives, exclusion
  frames, clause-start negation (anti-goldens `anti-assistance-*`, `negative-assistance-*`);
  authorization regions cut at the clause and validated; "sponsorship experience" is not a
  requirement; role-axis-only sponsorship corrections (`job-policy/3`); one `conflictFields`
  definition for companies and jobs. Deferred: a remote scope over a region with a
  single-country licence stays `company_capable`/medium — coverage refinement → **M11.2** (L5);
  lapsed GB dropped when licensed in IE → **M11.5** (L6).
- Operator path for existing data: the reprocessing runbook, "Re-interpret jobs after a logic
  change". Refreshed sources update on their own; everything else goes through
  `POST /api/jobs/:id/reinterpret`. The bulk migration is M11.2.

### M8.4 status (branch `market/m8-4-registers`)

Sponsor registers are **adapters** (owner request, DECISION_LOG "Owner request: add the
Netherlands and US H-1B sponsor datasets"): `packages/market/src/sources/providers/registers/`
defines `RegisterAdapter` (register id, source provider, parser per file format, route taxonomy
with a meaning per route `labour | history | ignored`, identity namespace, evidence tier, scope
country, publication URL and attribution) and `REGISTER_ADAPTERS`. The generic workflow
`market.sponsor_register.import` (`market.locate_register_download` → `market.acquire_snapshot` →
`market.parse_register_snapshot` → `core.for_each` `market.process_register_row` →
`market.finalize_dataset_import`) selects the adapter by the source `provider`. Contract:
[market-sources § Sponsor registers](../contracts/market-sources.md#sponsor-registers-register-adapters-m84).

- **UK unchanged:** `market.uk_sponsor_register.import` and `market.process_sponsor_row` are
  untouched; the UK adapter wraps the same `sponsorRowToPayload` (unit test: identical
  observations for every fixture row; int test: same licences through the generic workflow).
  Every UK route stays capability (`unlistedRouteMeaning: 'labour'`). Follow-up (decision needed,
  not v0.1 behaviour): whether UK Temporary Worker exchange routes (e.g. "Government Authorised
  Exchange") should be `ignored` like the NL exchange register.
- **NL IND** (`nl_ind_recognised_sponsors`): HTML register tables (organisation, KvK number, route
  from the heading) or an operator CSV with a Category column. Labour = regular labour and highly
  skilled migrants, researchers (Directive (EU) 2016/801), EU Blue Card; study, au pair, exchange
  and unrecognised headings are ignored (counted in the parse output, `unlistedRoutes`). Identity
  `nl_kvk` (8 digits; all-zero is a placeholder) when listed, else the name rules. Delisting and
  the anomaly guard are the shared finalisation. Golden suite `register-evidence`
  (`fixtures/golden/registers.json`): `nl-licence-not-uk-role`, `nl-non-labour-routes-ignored`,
  `nl-research-and-study-keeps-research-only`, `nl-blue-card-is-nl-only`,
  `uk-and-nl-licences-own-countries`, `nl-delisted-licence-previously-licensed`. Int:
  `nl-register.int.test.ts` (import with provenance, identical re-import changes nothing,
  delisting keeps history, KvK identity across a rename, anomaly guard, operator upload of every
  register, UK adapter through the generic workflow).
- The live IND pages were not reachable from the build environment (egress 403); the fixtures are
  synthetic samples of the documented page shape and the parser fails the run on an unknown page.
- `nl_kvk` is defined once in `companies/external-ids.ts` (PR #27 folded #32's
  `identity-namespaces.ts` into it; namespaces carry `kind` `register_id` | `row_identity`).
- New dependency for `packages/market`: `csv-parse` (already in the lockfile via
  `workflow-nodes`; the UK adapter reads the CSV with the same options as `core.parse_csv`).
- No migration, no Foundation change, no `packages/platform` change.
- Review fixes (DECISION_LOG "Sponsor register adapters" (1), (2), (10)): NL routes are labour only
  by exact alias (keywords only ever yield `ignored`, reported); explicit ignored aliases for
  seasonal labour, trainee, ICT and orientation year; a table without a heading of its own is
  ignored (shared or inherited headings, headings in cells and `<template>` never count); the NL
  default endpoint is the labour register page; namespaces carry a `kind` (row keys never
  contradict); the KvK placeholder rule rejects one repeated digit. Real-file gate: runbook
  "Sponsor register first import".
- Delta review (A-M1, A-M2, L4): route keys drop a "Public register"/"Openbaar register" prefix and
  a trailing directive reference before the exact-alias match (researcher and combined Blue Card
  spellings are labour); a `<figcaption>` or a bold-only paragraph directly before a table is its
  own label; a generic nearest heading ("Recognised sponsors") yields to the page h1 on a
  single-table page only; `<title>` loses its site suffix. The UK row key keeps auto-attaching
  through the M2 resolver in v0.1 (accepted; unused contradiction helpers removed).

### M11.5 status (branch `market/m11-5-h1b`, stacked on M8.4)

**Done: USCIS H-1B Employer Data Hub** as a third register adapter
(`us_uscis_h1b_employer_data_hub`, evidence tier `history`, scope US, route `H-1B` meaning
`history`, identity `us_h1b_employer` = strict name + state). Contract:
[market-sources § US](../contracts/market-sources.md#sponsor-registers-register-adapters-m84).

- Rows become `payload.sponsorshipHistory` observations; the company reconciler sums them per
  register, route and fiscal year into `employment.sponsorship.history[]` (each register row once
  across sources) and `historyCountries` (countries with ≥ 1 approval). History observations
  contribute no identity facts (names, aliases, legal name, locations). Company logic
  `company-reconcile/2`; the content hash includes history only when present (no churn).
- **Attach-only:** `CompanyPipeline.attachHistory` + `resolveHistoryAttachment` — identity key, or
  exactly one company with the exact own name and a known location in the row's state; ambiguous →
  `company_resolution` review with `merge | reject | dismiss` (no `create_new`); otherwise
  skipped (no observation). The creating resolver refuses history payloads.
- Job interpretation: `interpretationInput` passes `historyCountries` as
  `historicalSponsorshipCountries`; the company axis is chosen per job country (licence covering
  the job > history covering it > lapsed licence covering it > previous precedence). Policy and
  logic `2026-09-30.8`: run the outdated re-interpretation after deploy (runbook).
- Finalisation skips the shrink guard and delisting for history registers.
- Goldens (`register-evidence`): `h1b-history-not-role-yes`, `h1b-not-capability`,
  `h1b-non-us-job-ignored`, `h1b-history-only-company-not-capable`, `h1b-denials-only-not-history`.
  Int: `h1b-history.int.test.ts`. Unit: adapter formats (legacy CSV, current UTF-16 TSV),
  attachment resolver, per-country axis.
- PR #21 L6 is resolved by the per-country axis: a lapsed GB licence is kept for a GB job when the
  company is licensed only in IE (unit test).
- Review fixes (DECISION_LOG "Sponsor register adapters" (2)–(8)): `us_h1b_employer` is a row key
  (not an identity key, never proof — every row re-matches own name + state at import time; no
  duplicate-identity reviews); per (source, fiscal year) supersession with a per-year shrink guard
  (`source.health.historyPeriods`); NAICS in the row key and in-file summing; hashed record keys;
  history rows do not refresh company freshness; the role-overrides and right-to-work flags apply
  to history; label "Sponsorship history"; `legal_form_variant` counted skip; strict column count.
  Goldens `h1b-rows-differing-by-naics-sum`, `h1b-history-role-says-no-flag`,
  `h1b-history-rtw-tension-flag`; int: correction 10 → 11 (not 21), held-back shrunken year,
  second same-name company → review. `market.process_register_row@1` (input `row.history`) and
  `market.parse_register_snapshot@1` (input `snapshotId`, output `periods`) changed in place,
  additive: deploy with M8.4.
- Delta review (B-M1, B-M2, L1–L3, L5): the parse step decides each fiscal year against the marker
  it read and finalisation applies exactly that decision with a compare-and-set on the marker (a
  moved marker applies nothing and raises "marker moved"); one ratio (0.5); a held year gets its
  own `source_anomaly`, whose `confirm` accepts exactly that shrink on the next run of the snapshot
  (retry alone keeps it held); markers carry the parser version (re-reading the marker's snapshot
  with a new parser is guarded); reprocessing an older snapshot changes nothing (int test).
  `market.finalize_dataset_import@1` gained the optional input `periods` in place (additive).
- **Remaining in M11.5:** DOL LCA disclosures; company-level correction of a wrongly matched licence or history
  attachment.
