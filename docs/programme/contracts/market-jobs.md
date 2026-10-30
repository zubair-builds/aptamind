# Contract: Market jobs (list, detail, actions)

Owner: Market. Consumer: Admin UX (job list and job record). Status: **v2.4 (M11.5 H-1B history)** =
v1 (`d9799b6`) + strict query validation and DTOs (M7.1) + list v2 and the summary view (M7.3) +
record sub-resources, run history and the merged-job `survivor` (M7.6, v2.1) + the M6 and M11.1
changes in the changelog at the end; later items are marked with their PR.

Changelog: **v2.4** — M11.5 H-1B hiring history (`historical_evidence` for US jobs, per-country company axis, label "Sponsorship history"; policy `employment-policy/2026-09-30.8`): see § Changelog at the end. **v2.3** — M6.2 follow-ups (merged jobs' verifications, batch runs in run history): see § Changelog at the end. **v2.2** — M6 (PR #11) and M11.1 (PR #21): see § Changelog at the end. **v2.1** — M7.6
(`survivor`, `/api/jobs/:id/{observations,verifications,audit,runs}`), summary `factsHash`, titles
searchable from job insertion, `count=exact` refused on the semi-join fallback. **Documentation
correction:** `rev` and `contentHash` were described as a version pin; they are not (see § Version
pins) — behaviour unchanged. **v2** — M7.3 (with the PR #10 fixes). Conventions, Fact and
employment enums: [market-provenance](market-provenance.md). Code:
`apps/admin/lib/api-server/routes/entities.ts`, `packages/market/src/jobs/job.service.ts`, schema `jobDocSchema`
in `packages/market/src/jobs/job.schema.ts`.

## GET /api/jobs — list (v2, M7.3)

List v2 conventions (sort, `after`/`nextCursor`, `count`, `view`, multi-value and date
parameters): [market-provenance § List v2](market-provenance.md#list-v2-conventions-m72m75).
Code: `packages/market/src/api/jobs.ts` (`jobListQuerySchema`, `listJobs`). Every list parameter
takes `a,b` or repeated keys; values of one parameter are ORed, parameters are ANDed.

| Query                                                                  | Values                                                                                                  | Filter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `limit`, `offset`, `after`, `count`, `view`                            | see conventions                                                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `sort`                                                                 | `lastSeenAt`, `firstSeenAt`, `lastChangedAt`, `title`; `-` = descending. Default `-lastSeenAt`          | `lifecycle.lastSeenAt`, `lifecycle.firstSeenAt`, `lifecycle.lastChangedAt` (missing sorts first ascending / last descending), `identity.normalizedTitle`; `_id` tiebreak.                                                                                                                                                                                                                                                                                                                                    |
| `q`                                                                    | string (1–200)                                                                                          | **Title and company name** (M7.3): the query is split into words like titles are (lower-case, accents removed, split on punctuation; `c++`, `c#`, `.net` kept; single letters and words such as "of" kept); **every word must be a prefix of some title word** ("eng" finds "Engineer", "IT" finds "Head of IT"), **or** the job's company matches `q` as an anchored name/alias/domain prefix (company list search). **Breaking vs v1:** v1 matched a lower-cased substring (and missed mixed-case titles). |
| `state`                                                                | list of `DISCOVERED \| VERIFIED_LIVE \| CHANGED \| POSSIBLY_STALE \| CLOSED \| REOPENED \| REPOSTED`    | `lifecycle.state`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `companyId`                                                            | id list                                                                                                 | Pass **survivor** ids: a company merge moves jobs to the survivor in the same transaction.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `workModel`                                                            | list of `remote \| hybrid \| onsite \| unclear`                                                         | `geography.workModel.value`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `remoteScope`                                                          | list of `worldwide \| region \| country \| selected_countries \| timezone \| unclear \| not_applicable` | `geography.remoteScope.value.type`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sponsorship`                                                          | list of `explicit_yes \| explicit_no \| company_capable \| historical_evidence \| unclear`              | `immigration.sponsorship.value.status` (`company_capable` is company capability, not a role statement)                                                                                                                                                                                                                                                                                                                                                                                                       |
| `relocation`                                                           | list of `explicit_yes \| explicit_no \| possible \| unclear`                                            | `immigration.relocation.value`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `employmentType`, `seniority`                                          | lists of the employment enums                                                                           | `employment.employmentType.value`, `identity.seniority.value`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `authorizationRequired`                                                | `true \| false \| unknown`                                                                              | `immigration.authorization.value.required` is true / false / not known (null).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `country`                                                              | ISO-2 list, case-insensitive                                                                            | a normalised location in one of them **or** the remote scope lists one of them                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `minConfidence`                                                        | list of `<field>:<low\|medium\|high>`                                                                   | That fact's `confidence.level` is at least the level (all pairs must hold). Fields: `title`, `seniority`, `employmentType`, `workModel`, `remoteScope`, `sponsorship`, `authorization`, `relocation`, `compensation`.                                                                                                                                                                                                                                                                                        |
| `flag`                                                                 | list of flag codes (`[a-z0-9_]`)                                                                        | any `interpretation.flags[].code` in the list                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `verificationOutcome`                                                  | list of `live \| not_found \| inconclusive \| none`                                                     | `verification.lastOutcome`; `none` = never verified                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `verificationDue`                                                      | `true \| false`                                                                                         | `verification.nextVerificationDueAt` ≤ now / later or not scheduled                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `salaryStatus`                                                         | list of `parsed \| unknown \| ambiguous \| malformed`                                                   | `compensation.value.status` (`unknown` also matches a job without a compensation value)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `currency`                                                             | ISO 4217 list, case-insensitive                                                                         | `compensation.value.currency`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `minAnnual`                                                            | number ≥ 0; **requires exactly one `currency`** (400 otherwise: no currency conversion)                 | The annualised range reaches it: `annualized.max ≥ minAnnual`, or (no max) `annualized.min ≥ minAnnual`. Jobs without annualised pay never match.                                                                                                                                                                                                                                                                                                                                                            |
| `sourceId`                                                             | id list                                                                                                 | a source copy from one of these sources (current or not present)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `provider`                                                             | provider key list (`greenhouse`, `lever`, `ashby`, `careers_page`, `aggregator`, …)                     | any source copy of that provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `hasConflicts`                                                         | `true \| false`                                                                                         | ≥ 1 / no `quality.conflictFields`. **v2 change:** `false` now filters (v1 ignored it).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `hasOpenReviews`                                                       | `true \| false`                                                                                         | **Live:** an open review item names the job as its entity or as a candidate.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lastSeenAfter/Before`, `firstSeenAfter/Before`, `changedAfter/Before` | date or ISO date-time                                                                                   | `lifecycle.lastSeenAt`, `lifecycle.firstSeenAt`, `lifecycle.lastChangedAt` in [after, before)                                                                                                                                                                                                                                                                                                                                                                                                                |

Always `status: 'active'` (merged jobs are hidden). Unknown parameters and bad values are 400.

Response `ListPage` (`{ items, total, limit, offset, nextCursor }`):

- `view=full` (default): v1 items, DTO `jobListResponseDto` / `jobListItemDto`: `JobDoc & {
companyName: string | null }` with `content.descriptionText` and `content.shingles` **omitted**;
  everything else, including evidence, is present.
- `view=summary`: `JobSummary` rows (DTO `jobSummaryDto`, strict, each row ≤ `SUMMARY_ROW_MAX` =
  3 KB of JSON):

```ts
JobSummary = {
  _id, companyId, companyName: string | null, status, mergedInto?,
  identity: { title: SummaryFact<string>, seniority: SummaryFact<Seniority> },
  employment: { employmentType: SummaryFact<EmploymentType> },
  geography: { listedLocations: string[] /* first 3, as written */, locationCount: number,
               countries: string[] /* distinct ISO-2 of the normalised locations */,
               workModel: SummaryFact<WorkModel>, remoteScope: SummaryFact<RemoteScope> },
  immigration: { sponsorship: SummaryFact<Sponsorship>, authorization: SummaryFact<Authorization>,
                 relocation: SummaryFact<Relocation> },
  compensation: SummaryFact<{ status, min, max, currency, period, basis, annualized: { min, max } | null,
                              warnings: string[] /* first 3 */, originalText: string | null /* ≤ 120 chars */ }>,
  postingUrl: string | null,            // canonical posting URL, else the apply URL
  lifecycle: { state, firstSeenAt, lastSeenAt, publishedAt?, lastChangedAt?, closedAt?, closeReason? },
  verification: { lastVerifiedAt?, lastOutcome?, nextVerificationDueAt? },
  flags: { code, severity: 'info' | 'warning' | 'high' }[],   // messages on the record
  quality: { conflictFields, sourceCount },
  openReviewCount: number,              // live: open review items naming the job (entity or candidate)
  providers: string[],                  // distinct providers of the source copies
  hiddenByProvider: boolean,            // every present copy hidden by its provider (PR #11 U1)
  rev: number,                          // optimistic-concurrency revision of lifecycle/source-ref writes (0 before the first)
  contentHash: string,                  // lifecycle material hash: drives CHANGED; ignores fact status/confidence
  factsHash: string,                    // summary-row pin (drift detection): sha-256 over every summary fact's value, status, confidence
  interpretation: { logicVersion, policyVersion, taxonomyVersion },
  updatedAt,
}
```

**Version pins (cross-domain summary convention):**

- **Summary-row pin = `factsHash`.** It changes whenever any summary fact changes value, status or
  confidence (full stored values, not the trimmed summary values). It **detects drift only**: a
  consumer that stored it can tell the row changed, but there is no endpoint that returns the
  job as of an older `factsHash` (no version retrieval in v0.1).
- **Full job pin = `factsHash` + `contentHash` + `interpretation.{logicVersion, policyVersion,
taxonomyVersion}`**: the facts, the lifecycle material content, and the logic that produced
  them.
- `contentHash` alone is **not** a pin: it is the lifecycle material hash that drives `CHANGED`
  and ignores fact status and confidence (a fact turning `conflicting` leaves it unchanged).
- **`rev` means different things for jobs and companies.** Job `rev` counts lifecycle /
  source-ref writes (`JobService.casUpdate`); reconciliation writes are fenced on it but do not
  advance it. Company `rev` is the revision of the reconciled state: every reconciler write and
  every merge into the company advances it. Do not compare them across record kinds.
- _Documentation correction (PR #22):_ earlier text said `rev` and `contentHash` "pin a row"; they
  never did for jobs — the fields' behaviour did not change, only their description.

`openReviewCount` replaces the unreleased first summary's
`quality.openReviewCount` snapshot (the full document keeps that snapshot, taken at the last
reconciliation).

`SummaryFact` (value, status, confidence, `basis`, `alternates`) is defined in the companies contract. Summary facts keep their paths (for example
`geography.workModel.value`), so a column reads the same path in both views. The employment-enum
rules of the provenance contract apply unchanged (never render `company_capable` as "sponsors").
Compensation `annualized.assumptions`, `equityText`, `bonusText`, the full `originalText` and
warnings, remote-scope evidence and the office attendance fact are on the record only.

Performance notes: sorts and the `companyId` filter are index-backed (`list_seen`,
`list_first_seen`, `list_changed`, `list_title`, `list_company_seen`); `q` uses the
`by_title_tokens` multikey index of title words (anchored prefix per word) plus the company prefix indexes; `flag` uses `by_flag`; `sourceId` is an anchored prefix on
the unique source-key index. `hasOpenReviews` is driven from the open review items (ids of the
jobs they name, then `_id` in / not in; above 10 000 ids a per-row lookup); with it `count`
defaults to `none`, and `count=exact` is refused (400) in the per-row fallback.

## GET /api/jobs/:id — detail

`?view=summary` (M7.3) returns exactly one `JobSummary` list row of the requested document (DTO
`jobSummaryDto`). Any other query parameter is a 400.

Without `view`, DTO `jobDetailResponseDto`:

```ts
{
  job: JobDoc;                                   // full doc incl. content.descriptionText
  survivor: JobDoc | null;                       // M7.6: set when job.status === 'merged'
  company: { _id, name: string|null, domain: string|null,
             sponsorship: CompanyDoc['employment']['sponsorship'] };  // the company's survivor
  observations: JobObservationDoc[];             // resolved to this job, newest lastObservedAt, ≤50 (all source copies)
  sources: { _id, key, name, authority, provider }[]; // sources in job.sourceRefs, plus `system:operator`
                                                      // when job.overrides is non-empty (its evidence cites it)
  verifications: JobVerificationDoc[];           // applied verifications, newest first, ≤20
  reviews: ReviewItemDoc[];                      // all statuses, ≤50
  audit: AuditEventDoc[];                        // ≤50
}
```

- **Merged job** (M7.6): the requested document is returned **as is**, and `survivor: JobDoc |
null` is the job it was merged into (follows `mergedInto`, ≤ 10 hops; `null` unless merged). A merge
  chain that cycles, is longer than 10 hops or is broken is a **409** `conflict` (`details.reason:
cycle | too_long | broken`) on the detail and every sub-resource — never a merged "survivor".
  Show a "merged into" banner linking to `survivor._id`. The embedded related lists stay the
  requested job's; the paginated sub-resources below follow the merge.
- **Source copies**: `job.sourceRefs[] { key, sourceId, externalId, provider, authority,
postingUrl, applyUrl, requisitionId, firstSeenAt, lastSeenAt, present, providerState?,
lastObservationId, contentHash }`. The primary copy is `content.primaryObservationId` (the most
  authoritative _present_ copy). `present: false` means the latest successful listing of that
  source did not contain it. Other copies' disagreements appear as `conflicts[]` on the facts,
  and as a `field_conflict` review for compensation, remote scope or sponsorship.
- **Hidden by provider** (PR #11, ruling U1): `sourceRefs[].providerState: 'unlisted'` means the
  entry is on the provider's board but hidden from its public listing (Ashby `isListed: false`).
  Show a "hidden by provider" badge on that copy. Such a job is never closed by absence, but it
  cannot be verified: it becomes `POSSIBLY_STALE` through the freshness sweep and stays there
  until it is listed again. That is intended, not an error. The job-level flag is the summary's
  `hiddenByProvider` (list `view=summary` and the detail's `?view=summary`; every present copy
  hidden, `isHiddenByProvider`). Use it for a job-level "hidden by provider" badge; do not derive
  it in the UI.
- **Lifecycle**: `job.lifecycle { state, firstSeenAt, lastSeenAt, lastVerifiedAt, publishedAt,
lastChangedAt, closedAt, closeReason, consecutiveAbsences, absentSince?, consecutiveNotFound,
lastNotFoundAt?, history[{at, from, to, reason, sourceId, evidence}] }`. Render `history` as a
  timeline; `reason` is a machine string, show it verbatim. `listingMarks` and
  `appliedVerifications` are internal: do not render them.
- **Why an absent job is still open** (PR #11 ruling L1, `job-lifecycle/2`): absence alone never
  closes a job. `absentSince` is the source time of the first absence in the current run of
  consecutive absences. It is cleared when the job is seen again or verified `live`.
  `lastNotFoundAt` is the time of the latest `not_found` verification. There are two ways to
  close (PR #11 re-review MEDIUM-2):
  - **absence-driven:** a listing absence with `consecutiveAbsences ≥ 2` and
    `lastNotFoundAt ≥ absentSince`;
  - **verification-driven:** two consecutive `not_found` verifications, or one `not_found` while
    the job is absent from an applied listing.

  An **Ashby** check reads the whole board. It is the same evidence as a listing, never an
  independent verification (DECISION_LOG b7f1a76). Its `not_found` counts only for a job-level
  absence run: `consecutiveAbsences ≥ 2`, no sighting or live verification since `absentSince`,
  no hold on the source, and for an empty board no job on the source seen since. Otherwise it is
  `inconclusive`. So an Ashby job needs two applied absences before a board read can close it.
  Greenhouse and Lever single-job 404s are direct evidence and are not gated.

  **DECISION_LOG a9af734 (`job-verify/5`, `job-lifecycle/3`):** "seen" in these rules means an **authoritative**
  sighting (official ATS / official site, skipped entries included) or a live verification.
  Third-party sightings are evidence to show, not run evidence: they neither reset a run nor stop
  a closure. An absence after such evidence restarts the run (`absentSince` = that listing,
  `consecutiveAbsences: 1`). A verification result is re-gated when applied (completed by
  DECISION_LOG 0bcc357, `job-verify/6`): a `not_found` — board-derived or a direct Greenhouse /
  Lever 404 — checked before a later **authoritative** sighting or verification, or an Ashby
  `not_found` whose run changed since the check (by authoritative evidence only), is applied as `inconclusive`; a `live` result
  checked before the job was closed or recorded a `not_found` is applied as `inconclusive` (an
  older live read never reopens a job). The operation keeps its checked `outcome` and records
  `appliedOutcome` / `appliedNote`. "Absent from listings" is job-level: no authoritative copy
  present. Verification checks a present authoritative copy first, and only **authoritative
  copies on enabled sources**, on the copy's own board or its own posting URL: a third-party copy
  is never verified (its 404 is no evidence), a copy whose source is disabled or missing is
  never verified on a guessed target, and the canonical posting URL is never a fallback. A job
  whose only authoritative copies are on disabled sources therefore cannot be closed by
  verification: it decays to `POSSIBLY_STALE` until a source is re-enabled. "Authoritative" means
  `official_ats`, `official_site` or `operator` (an operator-entered copy is authoritative); an
  inherently third-party provider (`aggregator`) cannot be registered with those tiers.

  **Derived from an order-independent evidence set (PR #11 re-verify #8, DECISION_LOG 6a01b36,
  `job-lifecycle/5`, `job-verify/8`; supersedes the counter mechanics of re-verify #4–#7, keeps
  their rules):**
  - `lifecycle` (state, `consecutiveAbsences`, `absentSince`, `consecutiveNotFound`,
    `lastNotFoundAt`, `lastVerifiedAt`, `lastChangedAt`, `closedAt`, `closeReason`, `history`) is a
    **projection** recomputed from the job's evidence — every verification result and every
    listing presence/absence of each copy, recorded once — ordered by time, never by arrival. The
    fields and their meaning are unchanged; `lifecycle.derivedVersion` names the policy version
    that derived them. The same evidence gives the same lifecycle in any order.
  - A positive (a mapped authoritative sighting, a live verification) ends every negative before
    it; a not_found or absence counts only after the latest positive. So an older result applied
    late can move `lastVerifiedAt` forward to its own time at most, never reopen a job closed
    after it, and never extend a streak across a later live read.
  - Evidence counts according to its source's standing **at the evidence's own time** (enabled
    then, authoritative tier, not an aggregator, supported provider; DECISION_LOG 15c965b), and
    only if it was read on the board of the copy's latest sighting at or before it (canonical
    board identity: provider, API base, token). A listing of another board is no evidence about
    the copy: such a copy is "unknown" (neither present nor absent) and decays through the stale
    sweep. A later disable, re-enable or board change never rewrites the past — a CLOSED job
    stays CLOSED with its history — but a disabled interval ends a not_found streak or absence run
    and makes the source's copies unknown from then on. A standing change re-derives the source's
    jobs (time-based decay). No path closes a job while another counting copy's latest evidence is
    a positive within the stale window (72 h; else `POSSIBLY_STALE`, DECISION_LOG 9b0cb03): a
    not_found about one copy, or an absence run on one source, does not close a job another copy
    showed live recently; an older positive (e.g. a copy whose board moved) no longer blocks. A
    merge re-derives the survivor.
    A job with authoritative copies but no counting evidence at all is `POSSIBLY_STALE`; one known
    only from third-party copies is `DISCOVERED`.
  - `history` is the derived transition list (plus the history of a job written before
    derivation). Stale decay is dated at `lastVerifiedAt + 72 h`.
  - A copy is verified only on the board where it was seen, while the source still reads that
    board and its latest real listing fetch (`health.latestFetch`) succeeded; otherwise
    `inconclusive`. A result recorded under another verification logic version is recorded as
    `inconclusive` (`appliedNote` says why).
  - `verification.lastVerifiedAt` / `lastOutcome` are those of the latest verification (by check
    time); `nextVerificationDueAt` moves only when the applied verification is the latest one.
  - `operator` is an authoritative tier: operator assertions are first-party input.
  - Jobs written before derivation are widened on their first recompute with a conservative
    baseline (their last positive, their present copies, their closure — no negatives), so a
    legacy absence run or not_found streak restarts: a closure can be delayed by one cycle.

  So a `CLOSED` job may show `consecutiveAbsences: 1`. `closeReason` says which path closed it.
  A job with `consecutiveAbsences ≥ 2` and no such `not_found` is `POSSIBLY_STALE` and waiting
  for verification; show "absent from N listings, awaiting verification". Both fields are
  absent on documents written before `job-lifecycle/2`.

- **Verification**: `job.verification { lastVerifiedAt, lastOutcome: live|not_found|inconclusive,
nextVerificationDueAt }`. History items: `{ method: ats_api|posting_url|listing_presence, url,
httpStatus, outcome, detail, artifactId, stateBefore, stateAfter, at }`. `inconclusive` is
  never evidence of closure.
- **Description**: `content.descriptionText` (plain text). `content.descriptionArtifactId`, when
  present, holds the raw HTML: show it only as text via the artifact content endpoint, never as
  HTML.
- **Interpretation facts**: the employment enums in the provenance contract, plus
  `requirements.value[] { text, normalizedConcept, category, importance:
critical|important|preferred|incidental, explicitness, yearsMin, section, evidence, confidence }`
  and `responsibilities.value` (scope signals with evidence spans). Highlight evidence spans in
  the description with `locator` `#description[start:end]`.
- `aiProposals[]` are **non-canonical** proposals (`applied: false`). Show them separately as "AI
  suggestion", never merged into the canonical values.
- `overrides{field: {value, reason, actorId, at}}` are operator corrections, already applied to
  the facts, which then show authority `operator` and cite the `system:operator` source id as
  evidence (M7.1; see the provenance contract).

Errors: 404 for an unknown id.

## Actions

| Action       | Request                          | Response        | Notes                                                                                                                                                                               |
| ------------ | -------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verify now   | `POST /api/jobs/:id/verify`      | 202 `{ runId }` | `market.jobs.verify_due` with `jobIds: [id]`, label `jobId`. Can change the lifecycle (`not_found` twice → `CLOSED`). The result appears in `verifications` once the run completes. |
| Re-interpret | `POST /api/jobs/:id/reinterpret` | 202 `{ runId }` | `market.job.reinterpret` → `market.reconcile_job` with the current logic version. Idempotent. Bulk: `market.jobs.reinterpret_outdated` (reprocessing runbook).                      |

Corrections, merges and keep-separate decisions go **only through review items** (job fields
correctable there: `workModel`, `remoteScope`, `sponsorship`, `relocation`, `compensation`,
`employmentType`; the value is the full value shape of that fact).

## Job record sub-resources (M7.6, Admin ask API-5)

Paged with the list v2 parameters (`limit`, `after` → `nextCursor`, `offset`, `count`). For a
merged job they return the **survivor's** data. 404 for an unknown id; unknown parameters are 400.

| Endpoint                          | Query                                               | Items (order)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/jobs/:id/observations`  | paging, `current=true\|false`, `sourceId` (id list) | `JobObservationDoc & { current: boolean }` (every source copy's versions), newest `lastObservedAt` first, plus the page's `sources`. DTO `jobObservationsResponseDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/jobs/:id/verifications` | paging                                              | completed `JobVerificationDoc`s (in-flight operations are not evidence) of the job **and of every job merged into it** (any depth; M6.2: a verification keeps the `jobId` it was made against, a merge never rewrites it), newest `at` first. The endpoint follows a merged id to its survivor; the detail's `verifications` (≤ 20) are the **requested** job's (with the jobs merged into it), so they equal this list for an active job but not for a merged one. **UI rule:** a row whose `jobId !== job._id` is "from merged job <link to `/jobs/:jobId`>", and its `stateBefore → stateAfter` describe that merged record, not this job. DTO `jobVerificationsResponseDto`. |
| `GET /api/jobs/:id/audit`         | paging                                              | `AuditEventDoc`, newest `at` first. DTO `auditPageResponseDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/jobs/:id/runs`          | paging, `state` (list), `workflowKey` (list)        | `EntityRun` (`linkedBy` label / observation / verification / audit), newest `createdAt` first: runs labelled `jobId` (manual verify, re-interpret) with the job or a job merged into it (any depth), plus the runs that wrote its observations and verifications (and those of the jobs merged into it: listing refreshes, scheduled verification sweeps) and its audit events — which include the batch runs that **changed** it (M6.2): `market.source.recompute_jobs`, the freshness sweep's re-derivations and `market.jobs.reinterpret_outdated` (see [market-runs](market-runs.md)). DTO `entityRunsResponseDto`.                                                          |

**Gaps:** field explanation → **M12.4**; sponsorship `basisTier` and evidence ladder → **M11.2**
(additive fields).

## Changelog

**v2.4 (M11.5 H-1B history; policy `employment-policy/2026-09-30.8`, logic
`job-interpretation-rules/2026-09-30.8`).** Additive for the wire:

- `sponsorship=historical_evidence` is now produced: a job in the **US** at a company with US H-1B
  hiring history (USCIS Employer Data Hub, `company.employment.sponsorship.historyCountries`
  contains `US`) and no current licence covering the job is `historical_evidence` at **low**
  confidence, basis `company.historicalSponsorship`, `companyCapability: historical`,
  `capabilityCountries: ["US"]`, `roleStatement: none`. It is never `company_capable` and never
  `explicit_*`; a non-US job at such a company stays `unclear` (flag
  `sponsor_capability_other_country`). Label **"Sponsorship history"** (also for
  `companyCapability: historical`), description "The company's past visa petitions in this country
  (e.g. US H-1B approvals); not a current licence and not about this role." — never "Sponsored
  before", "sponsors" or "licensed". Detail line: "H-1B petitions approved (USCIS): FY… – n".
- The conflict flags cover history too: `sponsorship_role_overrides_company` (a stated "no" for a
  US job at a company with H-1B history, message "Company has sponsorship history but …") and
  `right_to_work_required_with_sponsor_capability` (the role requires existing work
  authorization); confidence stays low.
- The company axis is chosen **per the job's countries**: a current licence covering them, then
  hiring history covering them, then a lapsed licence covering them; when none covers them, the
  previous precedence (licence > history > lapsed) records the capability and the status is
  `unclear`. A GB licence therefore no longer hides US history for a US role. It also changes jobs
  of companies licensed elsewhere with a **lapsed licence in the job's country** (PR #21 L6, the
  intended fix): a GB job at a company licensed only in IE with a lapsed GB licence is now `unclear`
  with `companyCapability: previously_licensed` and flag `sponsor_licence_lapsed` (before:
  `licensed` IE and `sponsor_capability_other_country`). Other jobs are unchanged
  (re-interpretation only moves the version).

**v2.3 (M6.2 follow-ups; no policy version change).** Additive:

- `GET /api/jobs/:id/verifications`, the detail's `verifications` and the `verification` link of
  `GET /api/jobs/:id/runs` include the verifications of every job merged into the job (any depth).
  Nothing is rewritten: each verification keeps its own `jobId`.
- `GET /api/jobs/:id/runs` also lists, through new audit events on the job (`linkedBy: audit`),
  the batch runs that changed it: `job.lifecycle_rederived` (details `{ cause, from, to }`,
  `cause` = `source_standing` (with `sourceId`) | `recorded_evidence` | `stale_sweep`) and
  `job.reinterpreted` (details `{ fromPolicyVersion, toPolicyVersion, contentChanged }`). Best
  effort: at most one event per distinct change; a crash between the job write and the audit write can drop the link. A job a run re-derives without a change gets none. System actors:
  `system:market-lifecycle` (`job.lifecycle_rederived`) and `system:market-reinterpretation`
  (`job.reinterpreted`); the recovery auto-dismissal of `lifecycle_failure` items stays
  `system:market-lifecycle-recovery`.
- Verification rows from a merged job: see the UI rule under `GET /api/jobs/:id/verifications`.
- Runs labelled with a job merged into the job are followed at any depth (was: one hop).
- A lifecycle is never written onto a merged record: the recompute resolves the survivor (a broken,
  cyclic or over-long merge chain is a 409-class `MergeChainError`, kept on the retry list).

**v2.2 (PR #11 M6, PR #21 M11.1; policies `job-lifecycle/2`, `employment-policy/2026-09-30.7`,
`job-policy/3`).** Additive for the wire, but some filter results change meaning:

- `immigration.sponsorship.value.companyCapability` gains `previously_licensed` (a lapsed licence:
  past capability, label "Previously licensed", never "Sponsored before").
- `immigration.authorization.value.regions[]` (taxonomy region codes, e.g. `EU`). **Show region
  codes as given; never expand them to countries in the UI.** Documents interpreted before M11.1
  have no `regions` (treat as `[]`).
- New interpretation flag codes: `sponsor_capability_job_country_unknown`, `sponsor_licence_lapsed`,
  `right_to_work_required_with_sponsor_capability` (all `info`).
- `sponsorship=company_capable` **no longer includes** licensed employers' plain-"Remote" jobs with
  unknown countries (they are `unclear`, capability recorded); `historical_evidence` no longer
  includes lapsed licences.
- `authorizationRequired=true` **now includes** "must not require sponsorship now or in the
  future" jobs.
- **Sponsorship: posting text never yields a verdict (DECISION_LOG 012d041, v0.1 final; folded
  into v2.2 because PR #21 is not merged yet).** `sponsorship=explicit_yes` / `explicit_no`
  match **only** jobs whose sponsorship an operator asserted (review `correct` override) — a
  typed provider field would also count, but none exists today. A structured line in the
  posting ("Visa sponsorship: No", "- Tier 2 sponsorship: available", "Visa Sponsorship Available:
  Yes") is a **statement**: flag `sponsorship_stated` with `value` (`yes`/`no`) and `evidence`
  (the line). Contradictory stated values add `sponsorship_conflict` (high) and raise an
  `employment_conflict` review. Any other sponsorship / visa / right-to-work sentence — in the
  description, title or location — is `sponsorship_mentioned`; a stated value plus a mention adds
  `sponsorship_mixed_statement`. `sponsorship_role_overrides_company` marks a stated "no" where
  the licence covers the job's country. Interpretation flags gain optional `value` and
  `evidence` fields (additive). See market-provenance "Sponsorship rules".
- **Sponsorship statements, completed (DECISION_LOG 8d96663, narrowed by 3dfe3c5; PR #21
  re-verify #8/#9; policy `employment-policy/2026-09-30.7`):**
  - A stated value is **one text line** `key separator yes|no` — separator `:`, `–`, `-` or `=`,
    value `yes` or `no`, at most a trailing period, nothing else after it. Everything else is a
    mention: a key line without a separator ("Tier 2 sponsorship available", or "Visa sponsorship
    available" with "No" on the next line, a `<dt>`/`<dd>` pair, a heading and a paragraph);
    another value ("Visa sponsorship: Available", "Yes (London)"); a footnote marker after the
    value (`*`, `**`, `†`, `‡`, `^`, superscripts, `<sup>`); and **any table layout** (HTML table
    rows, markdown `|` rows). Only paired bold around the whole key or the whole value is
    formatting (`**Visa sponsorship:** Yes`).
  - **One canonical rendering (DECISION_LOG a720377):** statements are read from the enrichment
    rendering of the copy's `descriptionHtml` whenever it has one — whatever `descriptionText`
    the connector stored (the connector renderer joins table cells without a separator, e.g.
    `Visa sponsorship:No`) — and from `descriptionText` only when there is no HTML. Any line
    holding text of a `table`/`tr`/`td`/`th` element (with or without a `<table>` ancestor) is
    layout, never a stated value. **Narrowed by DECISION_LOG 5a13fed:** a line yields a stated
    value only if all its text sits solely inside the plain-flow allowlist (`body`, `section`,
    `article`, `div`, `p`, `li`, `ul`, `ol`, `span`, `strong`, `b`, `em`, `i`, `u`, `br`,
    `h1`–`h6`) with no `hidden`, `aria-hidden`, `role` or inline style that hides
    (display:none, visibility:hidden) or strikes (line-through) it; everything else — tables,
    ARIA grids, `s`/`strike`/`del`/`ins`, `mark` (not on the list: editorial highlighting), links,
    `details`/`summary`, `blockquote`, hidden content, anything unknown — is at most a mention.
    Layout lines are matched by position (start offset), never by text. The HTML rendering is
    used only when `descriptionHtml` contains markup: a tagless one (aggregator / JSON-LD plain
    text) is read as `description_text`, keeping its lines. **Narrowed again by DECISION_LOG
    7f01fe5 (no CSS is interpreted):** every element overlapping the line — ancestors,
    descendants, and any empty or line-breaking element inside it or at its boundary (`br`, an
    empty `p`/`div`/`span`) — must be an allowlisted tag with **no attribute other than
    `lang`/`dir`** (any `style`, `class`, `id`, `hidden`, `aria-*`, `role` … makes the line a
    mention); a non-allowlisted element even without text (svg, button, object, iframe) does the
    same; a `<style>`, `<link>` or `<script>` anywhere means no line of that description yields a
    stated value; and the HTML5 (parse5) and lenient (htmlparser2) parse trees must both render
    the line with the same text and agree it is unrestricted. The statement text is capped at
    200k characters without a partial last line, and the numero sign (`№`) is not "No".
  - **Realistic editors (DECISION_LOG bc013e8):** a `style` attribute is neutral only when every
    normalised declaration (split on `;`, lower-cased, whitespace removed) is one of
    `min-height:1.5em`, `font-weight:400|700|normal|bold`, `text-align:left|start|justify|inherit`,
    `list-style-type:disc|decimal`; a `class` only when every token is a provider wrapper
    (`content-intro`, `content-conclusion`); an attribute-free `hr` is a neutral boundary. No
    cascade and no computed values. So Ashby `<p style="min-height:1.5em">`, Greenhouse/Google Docs
    `<span style="font-weight: 400;">`, the `div.content-conclusion` wrapper and TinyMCE
    `text-align` / `list-style-type` give statements. **Recall residuals (stay mentions, by rule):**
    Lever `font-size` spans, Quill `ql-align-*` classes, Google Docs pastes with colours / font
    sizes, Word `MsoNormal` (and `o:p`), TinyMCE `font-family`. The corpus reports recall on its
    realistic-editor subset separately (`editor` cases, residuals counted as misses).
  - **A stated value keeps its key's scope (bc013e8):** `sponsorship_stated` of a country-specific
    key carries `scope` (H-1B → `["US"]`, Skilled Worker / Tier 2 → `["GB"]`, EU Blue Card → the
    participating EU countries, Employment Pass → `["SG"]`; a generic key has none), and its message
    quotes the key ("H-1B sponsorship: no"). A stated "no" lowers `company_capable` and sets
    `sponsorship_role_overrides_company` only when its scope (or, for a generic key, the job's
    countries) overlaps the licence countries — on any copy. **Re-verify #14:** that test is
    scope ∩ licence ∩ the job's countries (a Blue Card "no" for a Berlin + London job does not
    touch a GB + NL licence), and a "yes" and a "no" conflict only where their scopes overlap (a
    generic key overlaps every scope): "Skilled Worker sponsorship: Yes" with "H-1B sponsorship:
    No" for a London + New York job is no `sponsorship_conflict`. The conflict item's evidence is
    every stating entry's own line (deduplicated, never truncated) plus at most 3 licence
    references; its stating set is keyed by copy (source + record), value, key scope (`*` for a
    generic key) and the normalised stated line, the observation id kept for display, so a
    metadata-only re-observation of a stating copy or an edit around the stated lines asks nothing,
    while an edit of a stated line ("H-1B sponsorship: No" → "Visa sponsorship: No") asks again.
    Decisions recorded before these keys match by copy + value, or by observation + value.
  - **Residual bar (7f01fe5):** HTML deliberately constructed to get past these rules is rated
    Low: a stated value is never a verdict (only an operator sets `explicit_*`) and is always
    shown as an unverified quote ("The posting says: …"). `content.descriptionText` and the connector renderers are
    unchanged (no hash churn), so `compensation.originalText` and the `salary_suspicious` dedupe
    key are unchanged too. Sponsorship evidence into that rendering is labelled:
    `evidence[].locator` ends `#description.html_layout[start:end]` (offsets into the canonical
    rendering, **not** into `content.descriptionText`) and flag evidence carries `rendering:
'html_layout' | 'description_text'`. **Show the quote**; do not highlight such offsets in
    `content.descriptionText` (Admin shows locator and quote verbatim already). Residuals: a CSS
    `display: table` grid of `<div>`s is not detected; a copy with only plain text (e.g. Ashby
    `descriptionPlain` without `descriptionHtml`, which Ashby normally sends alongside) is read
    as text, so a table flattened by the provider onto one line ("Visa sponsorship: No") reads as
    a stated value.
  - A stated value **does not suppress company-level evidence**: the status follows the company
    axis (`company_capable`, `previously_licensed` capability → `unclear`, other-country or
    unknown-country → `unclear`) with its flags (`sponsor_licence_lapsed`,
    `sponsor_capability_other_country`, `sponsor_capability_job_country_unknown`) as before. A
    stated "no" — of **any** present copy — lowers `company_capable` to `low` and, when no copy
    states "yes", sets `sponsorship_role_overrides_company`. So `sponsorship=company_capable` now
    also matches licensed employers' jobs whose posting states a value (it was `unclear`); read
    `sponsorship_stated` / `sponsorship_role_overrides_company` next to it.
  - Stated values are compared **across all present copies**: an official ATS "yes" and a
    syndicated third-party "no" is `sponsorship_conflict` on the canonical interpretation, an
    `employment_conflict` review (whose evidence cites both lines and whose `context.stating`
    lists the stating observations and values), and the other copy's value kept on
    `immigration.sponsorship.conflicts[]` (reason `lower authority: the copy states visa
sponsorship no`, or `same authority disagreement: …`, which also lists
    `immigration.sponsorship` in `conflictFields`). After a sponsorship override these alternates
    are **kept after** the `overridden by operator` entry (never replaced).
  - **An operator decision records what it decided:** `correct` (of `sponsorship`), `dismiss` or
    `confirm` of the `sponsorship_conflict` item writes `job.sponsorshipDecision { stating:
[{observationId, value}], action, reviewItemId, actorId, at }`. While the current stating set
    is a subset of it, the conflict is the info flag `sponsorship_conflict_decided`, no review is
    raised and `immigration.sponsorship` is neither in `conflictFields` nor in a `field_conflict`.
    Any other stating observation — a new or changed copy, a copy merged in through `job_duplicate`,
    a reverted or re-attached one — raises it again. Open `employment_conflict` items whose flag is
    gone are dismissed by the system (actor `system:market-employment-conflicts`, reason "The
    <flag> flag is no longer present …"); a system closure is not a decision.
  - **Decided questions stay decided:** reconciliation does not re-raise a review whose last item
    for the same dedupe key was resolved or dismissed by an operator (not by the system, not by
    `retry`) with the same evidence — **any** earlier such decision, not only the latest
    (7f01fe5) — (`context.evidenceHash`, a per-kind digest independent of which copy is primary
    (5a13fed), versioned by `context.evidenceVersion` (now 2; a decision under another version
    asks once more): the stating set for a sponsorship conflict; for a work-model conflict or
    anti-signal, per copy that raises it the sorted `[observationId, hash of its own work-model
reading, lines and flag line]` — interpretations only, never the fact after an override, so a
    changed posting (new observation) asks again; the text and status for a salary; for a field
    conflict, per field the sorted `[observationId, reading]` of every present copy, primary
    included — keyed by copy (source + record), not observation, so a metadata-only
    re-observation or an edit that leaves the reading alone asks nothing, bc013e8). Open items are
    refreshed on every raise — `subject`, `reason`, `evidence`, `observationIds` and `context`
    together — so what is shown is what the digest covers, and a decision can carry it as If-Match
    (`evidenceHash`, review contract). A work-model / anti-signal item stays open while **any**
    present copy raises the flag and is closed by the system only when none does, whichever copy is
    primary (bc013e8). And it
    raises **no new review for a `CLOSED` job**. An item closed before 3dfe3c5 (no hash) does
    not suppress: where the condition still holds the question is asked **once more**
    (a720377 (2)); its reason ends "(asked again: the earlier decision predates evidence
    tracking)" for as long as the latest decision for the key has no current-version digest, and a decision on a never-refreshed item (dismiss, confirm or `correct`, also a
    sponsorship `correct` through a field_conflict item) returns `askAgain: true` in its result (the Admin shows it as raw JSON today: Admin follow-up).
  - Decisions are kept: a job merge keeps the survivor's `sponsorshipDecision`, else the merged
    job's; a `correct` of `sponsorship` through a `field_conflict` item (whose `context.stating`
    lists the stating set when sponsorship is among its fields) records a decision too. A decision
    on an item that carries no `context.stating` (never refreshed since 3dfe3c5) records nothing:
    the question is asked again on the job's next reconciliation. The `field_conflict` dedupe key
    names the fields asked; when a decided sponsorship leaves them, the remaining question is a
    different one and gets its own key.
  - Compounds ("Visumsponsoring", "Arbeitsvisa") and text with zero-width characters are
    mentions (relevance only).
  - Stored jobs are re-interpreted by the backfill workflow `market.jobs.reinterpret_outdated`,
    step 3 of the Market deploy (reprocessing runbook, "Market deploy": drain → start new → run
    until done; drain-first because the flag `value` validator narrows); nothing is downgraded at
    read time.
- **Flags in v2.2:** removed `sponsorship_conditional` (hedged offers were `explicit_yes` at
  `low`); new `sponsorship_stated`, `sponsorship_mentioned`, `sponsorship_mixed_statement`,
  `sponsorship_conflict_decided` (all `info`); `sponsorship_conflict` (high) is kept, now for
  contradictory stated values in one copy or across copies. A flag's `value` is only `yes` / `no`
  (only `sponsorship_stated` carries one; optional, so flags stored without it still parse; the
  `$jsonSchema` enforces the same).
- Sponsorship overrides decide only the role axis; the company axis is current (see the
  provenance contract, "Operator sponsorship override").
- `quality.conflictFields`: now only genuine disagreements (`conflicting` or same-authority), as
  for companies. Facts that only kept lower-authority alternates are no longer listed, so
  `hasConflicts=true` matches fewer jobs. The `field_conflict` review subject says "sources
  disagree" or "other values kept". Definition: provenance contract, "Conflict fields".
  - **Work-model override narrowing:** a `workModel` override keeps the replaced value as an
    `overridden by operator` alternate. It no longer lists `geography.workModel` in
    `conflictFields` either: an operator decision is not a source disagreement.
  - **One-time second review:** the job `field_conflict` dedupe key now names the reviewed
    fields (`field_conflict:job:<id>:<fields>`), not the whole `conflictFields` list. A job
    with an open item under the old key gets one more item on its next reconciliation. Dismiss
    the older one.
- Stale sponsorship override (PR #21 re-verify M3): its `field_conflict` offers only `correct`
  and `dismiss`. `dismiss` removes the stored override (audit `job.override_removed`), so the
  review does not come back.
- Lifecycle (M6): `lifecycle.absentSince`, `lifecycle.lastNotFoundAt`, `sourceRefs[].providerState`,
  summary `hiddenByProvider`, and the two close paths (see "Why an absent job is still open").
- Stored jobs keep old values until re-interpreted (reprocessing runbook).

**Lifecycle re-verifications (PR #11 M6, newest first):**

- **PR #11 re-verify #12**: the recorded-evidence sweep never stops for one job (a failing job is
  retried first by later sweeps; after 3 failures a `lifecycle_failure` review item names it), and
  evidence `createdAt` is the database's time, so a recorder with a wrong clock cannot hide
  evidence from it. DTOs unchanged.

- **PR #11 re-verify #11** (DECISION_LOG 9b0cb03, 6a01b36; `job-lifecycle/8`): a `present` copy
  keeps a job listed only while its latest positive is within 72 h, so a careers-page copy (whose
  listings never record absences) no longer blocks an absence-driven closure forever. A copy's
  first sighting is its earliest in the evidence, counted or not (a sighting while its source was
  disabled makes a later one after a closure a reopening, not a repost). Every job — CLOSED ones
  included — converges on the derivation of its evidence: the freshness sweep re-derives every job
  named by evidence recorded since its last pass, and complete listings record absences for jobs
  closed within the last 72 h too. A job may therefore leave `CLOSED` at a sweep when evidence
  recorded earlier (whose own step failed) says so. DTOs unchanged.

- **PR #11 re-verify #10** (DECISION_LOG 9b0cb03; `job-lifecycle/7`): every close path — not only
  the not_found one — needs that no other counting copy's latest evidence is a positive within
  72 h, so an absence run on one source no longer closes a job another copy verified live
  recently, and a stale positive (a copy whose board moved) no longer blocks a closure forever. A
  disable while `CLOSED` makes that source's copies unknown too (a later reopening is not kept
  "listed" by them). A repost is read from the evidence only: `reposts[]` and the `reposted`
  outcome follow the derived `REPOSTED` transition (a late sighting from before a closure is no
  repost). Evidence recorded by a step that crashed or gave up is folded by the job's next
  recompute of any kind. DTOs unchanged.

- **PR #11 re-verify #9** (DECISION_LOG 15c965b; `job-lifecycle/6`): standing and board are
  evaluated as of each piece of evidence's time, so disabling a source or changing its endpoint no
  longer changes any job's past (a CLOSED job stays CLOSED; nothing is closed backdated); a disabled
  interval ends a not_found streak or absence run. A not_found about one copy no longer closes a job
  whose other copy was last seen live (the job is `POSSIBLY_STALE`); a merge re-derives the
  survivor. A legacy `POSSIBLY_STALE` job stays `POSSIBLY_STALE` until newer evidence (no
  baseline flip, no backdated history entry). `CHANGED`/`REPOSTED` follow content hashes in time
  order; a repost is a closed job's new posting. Boards compare by provider, API base and token.
  DTOs unchanged.

- **PR #11 re-verify #8** (DECISION_LOG 6a01b36; `job-lifecycle/5`, `job-verify/8`): the lifecycle
  is derived from an order-independent evidence set (`market_job_evidence`). DTOs unchanged;
  additive: `lifecycle.derivedVersion`, verification history items carry `copyKey` and `board`.
  Behaviour: the outcome of out-of-order applies no longer depends on the order (a job may show
  `CLOSED` then `REOPENED` in `history` where an older read and a newer one disagree); a copy's
  evidence from another board never counts; disabling a source takes its evidence out of the
  derivation (superseded in re-verify #9: standing is evaluated as of the evidence time); third-party
  sightings no longer move a job to `CHANGED`; re-gated results no longer carry
  `appliedOutcome`/`appliedNote` (only a logic-version mismatch does). Admin: render `history`
  as given (it is recomputed, not appended).

- **PR #11 re-verify #7** (`job-verify/7`, `job-lifecycle/4`), additive: `sourceRefs[].board`
  (`{ endpointUrl, boardToken, apiBase } | null`, optional); verification history items carry
  `logicVersion`. Behaviour: timestamps are monotonic; a late (older) operation no longer moves
  `verification.lastOutcome`; operations whose source is gone, disabled or not authoritative, or
  recorded under another logic version, are applied as `inconclusive`; presence counts only
  copies on enabled sources; verification is `inconclusive` after an endpoint change (until the
  copy is seen on the new endpoint) or while the source's latest listing fetch has failed;
  aggregator copies are never authoritative; `operator` is authoritative. Admin: show the
  `appliedNote` of re-gated operations and, for an `inconclusive` verification, its `detail`.
