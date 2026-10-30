# Market domain

`packages/market` owns the meaning of Market Intelligence. It is exposed to workflows as
capabilities (`packages/market/src/workflow-nodes`) and to the API through the `MarketDomain`
facade (`market-domain.ts`). It depends on the runtime only via capabilities and two ports
(`RunLauncher`, `ScheduleSync`).

## Pipeline

```text
Source ─► Snapshot ─► Observation ─► Interpretation ─► Resolution ─► Reconciliation ─► Canonical
```

| Stage          | Company                                                                                                         | Job                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Source         | `market_sources` (acquisition workflow + config, schedule, freshness class, authority tier, governance, health) | same                                                                                      |
| Snapshot       | `market_snapshots` — content-addressed per source (bytes in S3)                                                 | same                                                                                      |
| Observation    | `market_company_observations` — append-only; id = hash(source, record, payload)                                 | `market_job_observations` — provider shapes mapped to `JobObservationPayload` by adapters |
| Interpretation | name/domain normalisation                                                                                       | `enrichment/interpretJob` (deterministic)                                                 |
| Resolution     | `resolution/company-resolver.ts`                                                                                | `resolution/job-resolver.ts`                                                              |
| Reconciliation | `reconciliation/company-reconciler.ts`                                                                          | `reconciliation/job-reconciler.ts` + `jobs/lifecycle.ts`                                  |
| Canonical      | `market_companies` (facts with provenance)                                                                      | `market_jobs` (facts, lifecycle, source copies)                                           |

Each stage is idempotent, so any stage can be retried and any snapshot re-processed. The
workflow runtime executes capabilities **at least once** (see
[workflow-runtime.md](workflow-runtime.md#idempotency-contract-audit-h-3)); _Replay safety_
below says how every Market state change stays correct when a capability runs twice.

## Provenance and confidence

Every material canonical field is a `Fact<T>` (`packages/provenance`): `value`, `status`
(`known` / `unknown` / `conflicting`), `confidence` (`high|medium|low|unknown` + reasons),
`evidence[]` (source, observation, snapshot, artifact, locator, quote, observedAt, authority,
extractor) and `conflicts[]`. `selectFact` chooses by field-specific authority, then confidence,
then recency; losing values are kept as conflicts — evidence is never discarded.

Authority tiers: `operator` > `official_registry` > `official_ats` > `official_site` >
`third_party` > `inferred` by default, overridden per field (e.g. display name prefers the
company's own site; legal name prefers the registry).

## Companies

**Resolution** (never auto-merges risky cases):

1. external/source id (`ext:<ns>:<id>` identity key) → match (high)
2. official registrable domain (`domain:<d>`) → match (high), unless the names are unrelated → review
3. exact legal name (strict key: case/punctuation/diacritics-insensitive, legal forms canonicalised,
   trading names split) or alias → match (high for registered legal forms; bare names in another town → review)
4. legal-form-insensitive name → brand name vs single legal entity = match (medium); otherwise review
5. fuzzy (Jaro-Winkler ≥ 0.92 within first-token block) → review only
6. otherwise create

Creation is protected by a unique multikey index on `identityKeys`; a lost race re-resolves to
the winner. Review items are deduplicated per question and hold the observation unresolved
until an operator merges, creates a distinct company (qualified name key + `distinctFrom`),
or rejects.

**Reconciliation** recomputes all facts from the _current_ resolved observations: display/legal name,
aliases, domain/website, industries, firmographics, HQ/registered/offices, careers URLs, ATS,
remote/relocation text, and **sponsor licences**.

**Bounded by records, not history (audit M-5).** Observations are immutable, so a record
re-observed with changed content adds a version. Versions of one source record (`sourceId` +
`externalId`, or `locator`) are totally ordered by **source chronology** (`sourceObservedAt`,
then `_id` as a deterministic tie-break); only the greatest is current and the rest are marked
`superseded` (kept as evidence, never deleted). The protocol — become current, supersede earlier
versions, then supersede self if a later current version exists — leaves exactly one current
version even with concurrent writers. Reconciliation reads current observations only (no
truncation; index `by_company_current`) plus the distinct names of superseded versions,
collected server-side, so a former name is always kept as an alias. Merging companies moves the
absorbed company's names into the survivor's aliases.

**Revision-fenced (B3-R2).** A company carries a revision `rev`. The reconciler reads the company
(and its revision R) **before** its evidence, computes the derived fields, and writes them with a
compare-and-set `WHERE rev = R` that advances the revision. A merge into the company also
advances it. If the revision moved, the computed state is discarded and the reconciler re-reads
and recomputes (bounded, 10 attempts). It never re-submits the old payload. A reconciliation
that missed newer evidence therefore can never commit over the reconciliation that follows that
evidence (for example the one triggered by a newer review decision). The write covers only the
derived fields (`COMPANY_RECONCILED_FIELDS`). Fields owned by other writers are never written
back from a stale read: `status`/`mergedInto`, `identityKeys`, `identity.distinctFrom`, and the
careers-discovery status. Identity keys and the resulting duplicate/conflict reviews are derived
from the committed state only. Benchmark (4 sources × 25 records × 30
versions = 3,000 observations): before, all 3,000 were current and the reconciler read the
newest 2,000 (silently dropping the oldest evidence) in 173 ms; after, 100 current observations,
27–31 ms (`company-reconcile-scale.int.test.ts`).

**Source chronology ≠ processing chronology.** An observation carries both:

| Field              | Meaning                                                                                                   | Moves on replay? |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ---------------- |
| `firstObservedAt`  | processing time of the first time Aptamind recorded the content                                           | no               |
| `lastObservedAt`   | processing time of the last (re)processing                                                                | **yes**          |
| `sourceObservedAt` | **source** time: the fetch time of the snapshot the content came from (recording time without a snapshot) | **no**           |

Reprocessing a stored snapshot reuses that snapshot's fetch time, so old content can never
become newer than content from a later fetch; `sourceObservedAt` only moves forward (`$max`)
when a genuinely later fetch sees the same content again (A → B → A makes A current again).
Supersession, fact recency, evidence `observedAt` and licence seen-dates all use source
chronology. The sponsor register's delisting marker (`health.lastCompleteImportStartedAt`) is the
imported snapshot's source time and only moves forward, so reprocessing an older register
snapshot neither delists sponsors a newer snapshot lists nor relists removed ones.

**Sponsor licence semantics.** A register row is company-level capability evidence
(`employment.sponsorship.capability = licensed`, licences per register+route). A licence is
`listed` while it appears in the latest _complete_ import of the register; otherwise
`no_longer_listed` → capability `previously_licensed`. A dataset that shrinks by > 50 % or
has > 5 % row failures does not advance the "complete import" marker and raises a
`source_anomaly` review — no mass delisting. Job listings have the same kind of guard (see _Lifecycle_,
shrink guard). **Registry presence is never projected onto a
job as "this job sponsors".**

## Jobs

**Resolution** (`JobCandidate` = source key, company, requisition, title key, location key,
URL fingerprints, description shingles):

| Situation                                              | Outcome                                                |
| ------------------------------------------------------ | ------------------------------------------------------ |
| same `sourceId:externalId`                             | same job                                               |
| posting/apply URL fingerprint match (other source)     | syndicated copy of that job                            |
| same company + requisition + same location             | same job; different location → distinct sibling        |
| same company/title/location, description Jaccard ≥ 0.8 | syndicated copy; if the match is `CLOSED` → **repost** |
| similarity 0.5–0.8                                     | new job + `job_duplicate` review                       |
| two live postings with the same title on one board     | distinct openings                                      |

**Reconciliation**: the primary copy is the most authoritative _present_ source; identity,
content and interpretation come from it; other present copies are interpreted too and their
disagreements recorded as conflicts (e.g. an aggregator saying "Remote (Worldwide)" for a
US-only role). Operator overrides are applied last with `operator` authority.

**Lifecycle** (`jobs/lifecycle.ts`, pure and golden-tested) is **derived from an
order-independent evidence set** (DECISION_LOG 6a01b36, `job-lifecycle/5`). Every verification
result and every listing presence/absence of a copy is recorded once, idempotent on its op/run key,
in the append-only `market_job_evidence` (`{jobId, copyKey, sourceId, board, at, kind, outcome,
logicVersion}`; `board` is the endpoint read when the fetch STARTED, carried through the fetch
output). `deriveLifecycle(evidence, sources, now, job)` recomputes the whole lifecycle — state,
absence run, not_found streak, `lastVerifiedAt`, history — under the job's revision fence on every
apply, absence application and stale sweep (`JobEvidenceService.recompute`); the stored
`lifecycle` is its projection (the API and DTOs are unchanged). The evidence is folded in one
canonical order (time, then positives before negatives, then key), so any arrival order gives the
same result (property-tested). **Standing and board are evaluated as of the evidence time**
(DECISION_LOG 15c965b, `job-lifecycle/6`): evidence counts only if its source exists and — at the
evidence's own `at` — was enabled (the source's `standingHistory`, appended atomically by every
enable/disable; tier and provider are immutable) with an authoritative tier (not an aggregator,
not a provider outside the closed set), and its board equals the board of the copy's latest
sighting at or before it, compared by canonical identity (provider, API base, token — not the raw
URL). A listing of another board is no evidence about a copy. So a later disable or board change
never rewrites the past (a CLOSED job stays CLOSED with its history); a disabled interval ends a
not_found streak or an absence run, as a positive would, and makes the source's copies unknown
from then on (also while the job is CLOSED; its closure stands). A standing change writes a
pending marker (`standingRecompute`) in the same update as its history entry (whose time is
strictly after the previous one's) and enqueues a bounded, paged recompute of the source's open
jobs (`market.source.recompute_jobs`, idempotent per change) so time-based decay applies; the run
saves a cursor after each page and honours cancellation, and a marker left pending is resumed by
a retry of the change or by the freshness sweep (DECISION_LOG 9b0cb03). Negatives count only
strictly after the latest counting positive; no path — absence-driven or not_found-driven —
closes the job while another counting copy's latest evidence is a positive within the stale
window (else `POSSIBLY_STALE`, `job-lifecycle/7`). A merge re-derives the survivor. `CHANGED` and
`REPOSTED` come from the sightings' recorded content hashes and from a copy's first sighting (in
the evidence only — a legacy copy carries a "seen" baseline), in time order; `reposts[]` and the
`reposted` outcome follow the derived `REPOSTED` transition. A job with authoritative copies but no counting
evidence at all is `POSSIBLY_STALE`; one known only from third-party copies is `DISCOVERED`.

**Bounded reads.** Each recompute starts from the job's fold checkpoint
(`market_job_lifecycle_checkpoints`: the fold state up to a watermark, the latest folded evidence
time) and reads only the evidence after it. The checkpoint is a derived cache — rebuildable, never
authoritative: it is ignored (full fold) when the policy version, the job's copies or the sources'
standing up to the watermark changed, or when the evidence at or before the watermark no longer
numbers what it folded — an index-only count (`by_copy_time`, `by_job_baseline`) on every
recompute, so late evidence is found whether or not its recorder ever recomputed (a crash,
exhausted retries, contention; DECISION_LOG 9b0cb03); a write never replaces a checkpoint that
folded more. A recorder that inserted evidence always completes a revision-bumping write. A
recompute that loses every compare-and-set (jittered exponential backoff) fails with a retryable
`RecomputeContentionError`: its node retries, and the evidence, already recorded, is folded by any
later recompute of the job. **Convergence never depends on a recorder** (re-verify #11): the
freshness workflow's `evidence` node (`market.sweep_recorded_evidence`, its own 8-minute budget)
reads evidence in record order (`createdAt`, `_id`; index `by_created`) after its watermark
(`market_job_evidence_sweeps`) and re-derives every job it names — CLOSED jobs included — in
bounded pages, keeping on while behind, then moves the watermark forward; it reports `complete`
and `lagMs`. Each job is isolated: a failing one is logged and recorded at once — before the
watermark can pass its evidence — as its own document in `market_job_lifecycle_failures`
(`failures`, `code`, `since`, `lastAt`), so nothing is capped, lost on an interrupt or erased by an
overlapping sweep; later sweeps retry those first, least recently tried first, within their
deadline, and a success deletes the document. A `lifecycle_failure` review follows 3 consecutive
failures (dismissed by the system on recovery; after an operator dismissal, raised again only
for another error code); the watermark moves on regardless. `createdAt` is stamped by the database server at insert (`$$NOW`)
and the cutoff is the server's time less a 5-minute lag margin: a document can become visible
after a newer one (its insert still committing), and the margin covers that (a document still
hidden past it would be missed; re-sweeping is harmless, the recompute being a pure
derivation). Complete listings record absences for jobs closed within the
stale window too, so the evidence set does not depend on a possibly stale `CLOSED` projection. A
`present` copy keeps a job listed only while its latest positive is within the stale window, and a
copy's first sighting (for `REPOSTED`) is its earliest in the evidence, counted or not
(`job-lifecycle/8`). Jobs written before derivation are
widened once, on their first recompute: copies adopt their source's board when the endpoint did not
change since they were last seen (else `null`, unknown), and a conservative baseline is recorded —
the positive at `lastVerifiedAt` (it sets only `lastVerifiedAt`; a non-live legacy state such as
`POSSIBLY_STALE` is kept), the presence of present copies, the closure of a closed job, the
history (never extended backwards), and **no** negatives (a legacy absence run or not_found streak
restarts: closure may be delayed by one
cycle). The rules:

- first seen on an official source → `VERIFIED_LIVE`; on a third-party source → `DISCOVERED`
- material content change → `CHANGED`; next unchanged sighting → `VERIFIED_LIVE`
- absent from a _complete, authoritative_ listing → `POSSIBLY_STALE` (+ verification).
  **Absence alone never closes a job** (ruling L1, `job-lifecycle/2`). An absence-driven close
  needs at least two consecutive absences **and** a `not_found` verification since the first of
  them (`lifecycle.absentSince`, `lifecycle.lastNotFoundAt`). A `live` verification ends the run
  of absences
- **an entry the adapter drops is never an absence (M6.1).** Adapters return every entry they
  did not map as `skipped[]` (`malformed`: fails the provider schema or the observation contract;
  `unlisted`: Ashby `isListed: false`). The entry is still on the board, so
  `finalize_job_listing@2` counts its external id as seen (`assessListing`,
  `jobs/listing-policy.ts`). A listing is not complete — no absences at all — when a malformed
  entry has no usable id (it could be any job) or more than 10 % of its listed + malformed
  entries are malformed (provider shape drift; `finishListing`; unlisted entries do not count).
  Identified skipped entries are recorded as `present` evidence with `skipped: true`
  (`JobPipeline.touchSkippedEntries`); a listing newer than the copy's last sighting also moves
  the copy's and the job's `lastSeenAt` forward and keeps the copy present. A skipped entry is on
  the board, so it ends the negatives before it (the absence run, the not_found streak), but it
  was not read (ruling U1): it moves neither `lastVerifiedAt` nor the state. An `unlisted` entry also sets
  `sourceRefs[].providerState: 'unlisted'` (**hidden by provider**). Such a job is never closed
  by absence (it is on the board) but is not verified either: the stale sweep makes it
  `POSSIBLY_STALE`, the Ashby check of a skipped entry is `inconclusive`, so it stays there.
  This is intended. A mapped sighting or an absence clears the provider state. Parser warnings raise a
  low-severity `parser_failure` review keyed by (source, adapter version, malformed-entry set):
  `dedupeKey parser_failure:<source>:entries:<adapterVersion>:<hash of malformed ids>`. Context:
  entry/mapped/malformed/unlisted/warning counts, `adapterVersion` and a sample of ≤ 5 warnings.
  A set whose latest item was dismissed is not raised again; a new finding dismisses the
  source's older open findings as superseded (system actor, audited). Unlisted entries are a
  provider state and raise nothing
- **shrink guard (M6.2).** A complete listing that collapses against the source's baseline
  (`health.listingBaseline`: the size of the last listing whose absences were applied) applies no
  absences. It is held when it is below 50 % of the baseline with at least 10 fewer entries
  (`isListingShrink`). The comparison uses the effective baseline, max(baseline, open jobs
  present on the source): a board whose stored baseline is 0 but which has live jobs (seen in
  held listings) is still protected (MEDIUM-1). An empty listing is therefore a shrink only after
  a board of ≥ 10. A
  smaller board that empties is held for **one run** without a review (`small_board_empty`,
  ruling L2); the next, later empty listing is applied, and its absences still need L1
  corroboration to close anything. A shrink raises a `source_anomaly` review (one per
  baseline). A held listing is a **successful fetch, not a failed run**: `health.listingHeld
{reason, since, lastAt, count, baseline, reviewId?}` marks the hold and is cleared when a
  listing is applied. The baseline does
  not move, so the guard holds every time the anomaly recurs; the old empty-listing guard held
  only once. The next normal listing proceeds. When an operator `confirm`s the review, the
  confirmed size becomes the effective baseline and the next listing is applied, unless it
  collapses again. The review is keyed to the baseline instance (snapshot plus source time), so a
  confirmation never outlives it. Sources without a baseline (applied before M6.2) use the larger
  of `lastItemCount` and their jobs with a present copy (A-M1: the old guard left
  `lastItemCount = 0`). `SourceService.recordListingApplied` writes the baseline before the
  `lastListingAppliedAt` watermark, so a crash between the two replays into a full
  re-application and not into a stale baseline
- **source fetch failure → no change**; absence from third-party listings is ignored;
  reprocessing an old snapshot never counts as a new absence
- verification-driven close: `not_found` twice, or once while absent from an applied listing →
  `CLOSED` (so a closed job may show `consecutiveAbsences: 1`; absence-driven closes are above).
  `inconclusive` → no change; `live` → `VERIFIED_LIVE` and the run of absences ends; `live`
  after closure → `REOPENED`. A **board-derived** check (Ashby reads the whole board) counts as
  `not_found` only on a trustworthy board: see Verification below (L1, A N-M3, MEDIUM-1;
  `boardDerivedNotFoundGate`)
- closed job seen again → `REOPENED`; re-listed under a new posting → `REPOSTED`
- unconfirmed for longer than the freshness window → `POSSIBLY_STALE` (never closed by time alone)

## Replay safety (at-least-once execution)

Every Market side-effecting capability is `key` or `natural` in the capability matrix
([capability-idempotency.md](capability-idempotency.md)); the mechanisms are:

| Change                                         | Strategy                                                                                                                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job document updates                           | Revision compare-and-set: every write filters on `rev` and increments it (`JobService.casUpdate`, `revisionFilter`); a lost race re-reads and re-derives. Reconciliation writes only derived fields.                                                 |
| Listing absence / presence (B-1)               | **Evidence keys.** Each listing's statement about a copy is one evidence document `listing:<copy>@<fetch time>:<outcome>`; a crash/replay records nothing new, and the job is re-derived from the whole set, so an absence is never counted twice.   |
| Sightings                                      | A sighting at or before the ref's `lastSeenAt` is a replay (`replay:source_key`): its evidence key already exists and the copy's newer content is kept.                                                                                              |
| Verification (B-2)                             | **Verification operations** whose result is recorded once as evidence `ver:<operation id>` (see below).                                                                                                                                              |
| Review resolution (B-3)                        | **Durable review operation** (see _Review queue_); a `retry` decision's source run is launched only from its durable, generation-bound retry intent.                                                                                                 |
| Company reconciliation (B3-R2)                 | Revision compare-and-set on `market_companies.rev` over the derived fields only; a lost race re-reads and recomputes (never re-submits the stale payload).                                                                                           |
| Source health counters                         | **Logical** per-run counting: a marker `source:run:outcome` is inserted in the same transaction as the increment (see below).                                                                                                                        |
| Observations                                   | Deterministic ids (hash of source, record, payload); `fetchCount`/`seenCount` count distinct runs, so a replayed run does not inflate them.                                                                                                          |
| Companies created from a review (`create_new`) | Deterministic id `cmp` + review item; a duplicate insert returns the existing company.                                                                                                                                                               |
| Merges                                         | Transactional and guarded on `status: 'active'`; merging an already-merged entity into the same survivor is a no-op, into a different survivor an error.                                                                                             |
| Audit events tied to a review item             | Deterministic id, written with `$setOnInsert`.                                                                                                                                                                                                       |
| AI proposals (`propose_job_requirements`)      | **AI operation ledger** `market_ai_operations` keyed by the node's idempotency key: a replay reuses the recorded proposal instead of calling the model again (`ai_calls_repeated_total` counts any repeat); the job's proposal is pushed once by id. |

Uniqueness indexes on identity (`uniq_source_keys`, `uniq_identity_keys`) are partial on
`status: 'active'`, so merged entities never collide; `ensureCollections` drops and recreates
an index whose definition changed. `ack-replay.int.test.ts` injects an acknowledgement failure
after every Market side-effecting node and asserts the final state equals a fault-free run,
with one AI call.

**Lifecycle snapshot idempotency.** The rule "the second consecutive absence closes a job" (once
corroborated by a `not_found`, L1) counts _listings_, not deliveries: the same snapshot applied
twice (retry, takeover, operator re-run) is one piece of evidence per copy. Reprocessing an older
snapshot adds evidence at that snapshot's (older) fetch time, on the board that fetch read; the
derivation orders by time, so it never counts as a newer absence. Reprocessing never changes
source health.

**Verification replay (lifetime-safe).** `VerificationService.verify(jobId, http, { operationKey })`
is an operation with a deterministic id (`ver` + job + operation key, the node's idempotency key):

```text
claim ─► check (HTTP) ─► recordResult (status: checked, result stored with its copy and board)
      ─► applyToJob: record evidence `ver:<operation id>` (once) ─► re-derive the job (revision CAS)
                     ─► operation.lifecycleApplied := true
      ─► complete (status: applied)
```

A replay at any boundary resumes from the recorded step: a `checked` result is not re-fetched,
and the result counts **at most once for the lifetime of the operation**, because it is one
evidence document keyed by the operation. It cannot be evicted (an earlier design kept the last 50
applied ids on the job; a replay after 50 newer operations applied a `not_found` twice — that
probe is a permanent test). Because the lifecycle is a function of the evidence SET ordered by
time, the order in which operations are applied never matters (re-verify #8 HIGH-A). An operation
recorded under another verification logic version (`job-verify/8` now) is recorded as
`inconclusive` — an in-flight check from before a deploy changes no job state; the job is simply
verified again at its next due time. History and the API show only `applied` operations.

**Evidence retention.** `market_job_evidence` is append-only and, for v0.1, kept in full
(removing history needs a supervisor ruling). Volume: one document per copy per applied listing
(present or absent) plus one per verification — about (copies × listings per day) + verifications,
~250 bytes each. At 100 boards × 30 jobs × 2 listings a day that is ~6,000 documents (~1.5 MB) a
day; at 10,000 boards × 50 jobs × 4 a day, ~2 M (~0.5 GB) a day — the point at which a retention
ruling ("keep everything after the latest positive plus N") is needed. A recompute reads one job's
evidence by copy key (`by_copy_time`).

**Source health telemetry.** `source.stats.attempts/successes/failures` and
`health.consecutiveFailures` (which drives `health.status`: `degraded` after one failed run,
`failing` after three) count **logical source runs**: each workflow run counts at most once per
outcome, however many times its steps are retried, taken over or replayed after a lost
acknowledgement. The increment commits in one transaction with a marker document
(`market_source_run_outcomes`, `_id = <source>:<run>:<outcome>`). Calls without a run id (manual
uploads) count per call. Timestamps (`lastAttemptAt`, `lastSuccessAt`, …) record every call.

**Retention.** Operation records that act as replay fences — verification operations, review
operations, AI operations, source-run outcome markers — are retained indefinitely (no TTL). The
replay horizon of a logical operation is currently unbounded (a workflow run or an API client
can retry at any time), and a record may only be removed once its operation can no longer be
replayed; any future archival must first bound that horizon.

## Employment intelligence

`enrichment/interpretJob(input)` is deterministic and versioned (`logicVersion`,
`policyVersion`, `taxonomyVersion`); every non-unknown field carries verbatim evidence spans.
Its input for a stored job is built in one place: `interpretationInput(observation, company)`
(`reconciliation/interpretation-input.ts`). That input has the copy's title, description,
locations and provider fields (workplace type, employment type, department, pay) and the
company context (current licence countries, lapsed licences as history, HQ country).
Reconciliation and the `market.interpret_job` inspection (`JobReconciler.interpret`) share it and
the primary-copy choice (M6.4). An inspection therefore returns the primary copy's interpretation,
which reconciliation starts from. It is not the stored facts: reconciliation then applies
cross-copy conflicts (other copies' values) and operator overrides.

- **Work model**: `remote | hybrid | onsite | unclear` — never a boolean. Each statement is
  classified by **stance** before it can decide the role's work model (audit H-2):
  - `role` — about this job ("This role is fully remote", "You will be based in our London
    office"); a negated role statement ("This role is not remote") is evidence against remote
    (basis `description.not_remote`).
  - `company` — about the employer ("We are a remote-first company", "Acme operates
    remotely"): context, never decisive for the role.
  - `preference` — what a candidate wants ("Candidates who want a fully remote role…", "Do
    you prefer to work remotely?"): ignored.
  - `anti_fit` — who will not fit ("You might not be a fit if you prefer an in-person role"):
    evidence _against_ the model it names, never for it.

  Clauses are split, headings/lead-ins ("Our culture:", "Benefits") are taken into account.
  Role statements override provider flags and location labels; a strong explicit statement
  that contradicts a structured provider value raises `work_model_structured_conflict` and
  lowers confidence to medium; an anti-fit statement that contradicts the provider raises
  `work_model_anti_signal`. The live Ashby regression — a remote role (provider
  `workplaceType: remote`) whose "You might not be a fit if … you prefer an in-person role over
  remote (Ashby operates remotely)" was read as onsite — now stays remote with no conflict flag
  (golden `ashby-remote-preference-not-onsite`).

- **Remote scope**: `worldwide | region | country | selected_countries | timezone | unclear |
not_applicable`, with allowed/excluded countries/regions and UTC offset windows. Plain
  "Remote" without scope stays `unclear`. "Remote" labels restricted by the body raise a flag.
- **Sponsorship**: `explicit_yes | explicit_no | company_capable | historical_evidence |
unclear`, with `roleStatement` and `companyCapability` (`licensed | previously_licensed |
historical | none | unknown`) recorded separately. Evidence hierarchy: role explicit statement >
  application constraint > company policy > company capability > hiring history > inference.
  Explicit job statements win (including "visa assistance/support" offered). `company_capable`
  requires a current licence in **at least one** of the job's known work countries (a remote
  scope over a region counts all its member countries, so a single-country licence inside the
  region qualifies: a coverage refinement is M11.2). With unknown job countries the status stays
  `unclear`, with the capability recorded (M11.1, supervisor ruling).
  A right-to-work requirement where the licence applies lowers it to low confidence with an
  info flag. A lapsed licence is past capability (`previously_licensed`, `unclear`), not hiring
  history. `historical_evidence` is reserved for hiring-history datasets (M11.5).
  `company_capable` is never presented as `explicit_yes`.
- **Authorization** (`required`, `countries[]`, `regions[]` — e.g. "eligible to work in an EU
  country" → `EU`, never expanded into invented countries — and qualifiers; "must not require
  sponsorship now or in the future" is a requirement), **relocation**
  (`explicit_yes|explicit_no|possible|unclear`), **employment type**.
- **Compensation**: min/max/currency/period/basis with annualised values and explicit
  assumptions; original text retained; `$` outside the US is `ambiguous`; missing pay is
  `unknown`, never 0; ambiguous/malformed salary raises a low-priority review. An explicit,
  unambiguous currency code wins over a symbol (`$150k USD` is USD anywhere); an open-ended
  `£80k+` is a minimum only (`max = null`, with a warning); bonus idioms ("As a bonus, you
  have experience with…") are not compensation, while a real bonus ("£80k + bonus", "annual
  bonus") is kept as `bonusText` beside the base pay and never makes a range open-ended
  (audit M-2).
- **Requirements**: section-aware extraction with importance
  (`critical|important|preferred|incidental`), category, explicitness, years, normalised
  concept (taxonomy skills) and evidence offsets. **Responsibilities**: scope signals.

AI is optional and additive: `market.extract_jobs_from_pages` falls back to schema-validated
AI extraction for crawled pages without JSON-LD (provenance recorded on the observation);
`market.propose_job_requirements` stores AI proposals on the job without changing canonical
requirements.

## Verification and freshness

Freshness policies differ by data class (`freshness/policies.ts`): active jobs 24 h
(stale after 72 h), ATS listings 6 h, careers pages 24 h, sponsor registers 24 h, careers
discovery 14 days, firmographics 30 days. `market.jobs.verify_due` (hourly) checks jobs due for
verification against the provider API (Greenhouse/Lever job endpoints, Ashby listing presence) or
the posting URL, stores the evidence (`market_job_verifications` + artifact) and applies the
lifecycle policy. The ATS check targets the host the copy's own source is fetched from: the API
base is recovered from the source's `endpoint.url` (`apiBaseOfListingUrl`: the adapter's known
bases by prefix first, then its listing path stripped from the URL). A source without an
endpoint URL (only legacy documents: registration and `PATCH` store the default listing URL) is
verified on the adapter's default host, where its fetch got the jobs (E1). If the source document
is missing, or its URL does not identify the base, the check is `inconclusive`: it never guesses
a host (M6.3). `not_found` needs positive proof:
a 404/410 from the Greenhouse or Lever job endpoint, or, for Ashby (no single-job endpoint), a
complete, readable board listing that neither maps nor skips the job. Ashby shape drift, an
unparseable, unlisted or id-less entry, and any other HTTP status are `inconclusive` (PR #11
A-H1). Otherwise a drift would close every Ashby job through stale → verify → 2× `not_found`.
The board gate (`boardDerivedNotFoundGate`) then decides whether an Ashby `not_found` counts
(DECISION_LOG b7f1a76; this replaces the earlier board-derived clauses). A board read is **the
same evidence as a listing read**, never independent verification. It can only corroborate a
**job-level absence run**, which requires all of:

- `lifecycle.consecutiveAbsences ≥ 2`, counted at the job level. The count does not grow while
  another authoritative copy is present, so an Ashby copy that died while the job is live on
  its careers site never closes it.
- No AUTHORITATIVE positive evidence for the job since the first absence
  (`lifecycle.absentSince`): no official-ATS / official-site sighting, mapped or skipped, in a
  held listing too, and no live verification (`authoritativeEvidenceAt`, DECISION_LOG a9af734).
  A third-party sighting is not run evidence. An absence after such evidence restarts the run
  (`absentSince` = that listing, count 1), so a skipped-entry sighting cannot block it forever.
- No hold in force on the source (`health.listingHeld`).
- For an **empty** board: no positive evidence on the source (any of its jobs) since then. For a
  non-empty board: not a shrink against the effective baseline, `max(listingBaseline.count, open
jobs present on the source)` (A N-M3).

Otherwise the read is `inconclusive`. A small-board hold is **re-armed** by positive evidence on
the source itself (its own copies' sightings, or a live verification whose `sourceId` is that
source; a9af734 M2) after it was set.

**Check and apply are separate steps** (a resumed operation applies after any retry delay), so a
persisted `not_found` is **re-gated at apply** in the same compare-and-set (a9af734): it is applied
as `inconclusive` when the job was seen on an authoritative source or verified at or after the
check (board-derived and direct 404s alike; third-party sightings never block a closure), and a
board-derived one also when its recorded run fence (`absentSince`, the latest authoritative
sighting, `lastVerifiedAt` at check time) moved — a third-party sighting moves neither. A persisted `live` is applied as `inconclusive` when the job was closed, or
recorded a `not_found`, at or after its check (DECISION_LOG 0bcc357). The operation keeps the check's `outcome` and records `appliedOutcome` / `appliedNote`.
The copy to verify is a **present authoritative copy first** (then authority, then recency),
among copies whose source exists and is enabled (a disabled or missing source is never verified
on a guessed target: no board check, no posting-URL fallback), checked on that copy's own board, and "absent from listings" is job-level: no authoritative copy
present (third-party copies never count either way). A dead small Ashby board
therefore closes its jobs after hold → apply → apply → read. Direct single-job 404s (Greenhouse,
Lever) keep the verification-driven path unchanged. An EU board asked on the US host
answers 404, and that must never count as "not found". `market.freshness.sweep` marks unconfirmed jobs `POSSIBLY_STALE` and reports
overdue sources.

## Careers discovery

`market.discover_careers` fetches the company homepage (host-scoped to its official domain),
ranks careers links, tries a bounded set of candidate paths, detects ATS boards from URLs and
embeds, records a discovery observation (authority `official_site`) and reconciles.
`market.company.discover_careers` then registers each detected board as a scheduled job source
(idempotent on `provider:token`); a board already linked to another company raises a review.
**Regional hosts (M6.3):** a detection carries the provider API base of the board's region
(`*.eu.greenhouse.io` → `boards-api.eu.greenhouse.io`, `jobs.eu.lever.co` → `api.eu.lever.co`).
Registration (`boardSourceIdentity`) accepts only the adapter's known bases. It stores the
regional listing URL as `endpoint.url` and keys the source `provider:region:token` (default-region
keys are unchanged). A `PATCH` that sends only a new board token keeps the API host derived from the source's
stored `endpoint.url`, and is refused when that URL does not identify it: the default host is
never substituted (PR #11 LOW-1). If the same company also has an enabled source for the token on the default
key (registered before M6.3, on a host where the board does not exist), a low `careers_discovery`
review is raised.
Companies without a known website are marked `website_unknown` (no guessing).

## Review queue

Types: `company_resolution`, `company_duplicate`, `job_duplicate`, `field_conflict`,
`employment_conflict`, `salary_suspicious`, `parser_failure`, `source_anomaly`,
`careers_discovery`. Actions: `confirm`, `correct`, `merge`, `create_new`, `keep_separate`,
`reject`, `retry`, `dismiss` (allowed actions are stored per item). Decisions are applied
through the same domain services, audited in `market_audit_events`, and resume any workflow node
waiting on the item.

**Durable review operation (audit B-3).** A resolution is a durable operation
(`market_review_operations`, one record per review item — resolved items are never reopened):

```text
validate decision (nothing persisted if it fails)
  → claimed G ──canonical effects + result: ONE txn whose first write re-asserts G──► applied G
     (retry: the effect is the durable retry intent — no run is launched here)
  ──derived recompute (revision-fenced); close item + finalize: one txn fenced on G──► finalized
  ──outbox: retry-intent dispatch, audit event, workflow resume──► completed

claimed G ──deterministic failure (nothing committed)──► failed ──corrected decision──► claimed G+1
claimed/applied ──transient failure──► unchanged + lastError (owner resumes, or recovery takes over)
```

- **Validation before the claim.** Before anything is persisted the decision is checked for shape
  (action allowed for the item and supported by its type; `targetId` present — or implied by a
  single candidate — and a candidate; `field`/`value` present, the field correctable and the
  value valid for the canonical schema) and for every domain precondition that can be checked now
  (target exists and is active, merge legal, `create_new` would not clash with another active
  company's identity — the operator is told to merge instead —, source exists and is enabled).
  An invalid decision gets `validation_failed` (HTTP 400) and never becomes the item's operation.
- **One decision.** The first valid claim stores the decision (with its implied target made
  explicit); nothing else is applied while it lives. Concurrent resolvers get `ConflictError`
  (HTTP 409) and change nothing.
- **Generation-fenced effects.** Every canonical write of a decision — observation resolutions,
  created companies, merges, distinct markers, job overrides (which also move the job revision),
  operator correction observations, audit events of the effect, dependent observations re-opened
  — commits in **one MongoDB transaction** together with the result (`applied`), and the
  transaction's first write is a compare-and-set on the operation (`generation = G, state =
claimed`). A resolver that lost generation G commits nothing: effect-then-check is impossible.
  While the transaction is open, a recovery waits for it and then finds the lease renewed; if the
  recovery got in first, the transaction's fence write conflicts and fails.
- **The one external effect: a durable retry intent (B3-R1).** `retry` of a source starts a
  workflow run, which is not a Mongo write. The owner never launches it. Its effect is a
  **retry intent** (`market_review_retry_intents`, id deterministic per item + operation),
  inserted in the same generation-fenced transaction that moves the operation to `applied`. The
  authority to launch therefore exists iff the retry decision won. An owner that lost its
  generation, or a decision released and re-decided meanwhile (e.g. dismissed), commits no
  intent and can never cause a run. The run is started later by the dispatcher, as the first
  outbox step or by the dispatcher sweep. Before launching, the dispatcher checks that the intent
  is its item's decided `retry` (same operation, state `applied`/`finalized`/`completed`, result
  naming this intent). That predicate is monotonic because an applied decision is never released
  or re-decided, so the check is not a check-then-act race. An intent that fails it is
  `cancelled` and never launches. The dispatcher records the attempt (`dispatching`, attempts)
  and starts the run with the intent's idempotency key. That key is unique in the workflow run
  store, so a re-dispatch after a crash, even after the run started, or concurrent dispatchers
  get the same run. It then records `delivered` with the run id, which also goes into the
  operation result and the item's resolution. A source that became missing or disabled after the
  decision settles the intent as `failed` (no launch); a transient launch error leaves it
  undelivered for the next dispatch.
- **Derived state after the fence.** Reconciliation (company/job derived fields) runs after the
  effect transaction, after another ownership check, and before closing. It is the same recompute
  automation runs. Both reconcilers are revision-fenced: job reconciliation CASes the job
  revision, and company reconciliation CASes the company revision and recomputes from a fresh
  read on conflict. A stale owner's precomputed snapshot therefore can never overwrite newer
  canonical state; at most it recomputes current truth before its close is rejected.
- **Closing is fenced.** Closing the item and finalizing the operation commit in one transaction
  fenced on `generation = G, state = applied`.
- **Lease renewal.** A working owner renews `owner.at` every `REVIEW_HEARTBEAT_MS` (1 min, fenced on
  its generation), so a slow but healthy resolution is never taken over; only an owner that stopped
  renewing for `REVIEW_CLAIM_STALE_MS` (10 min) is recoverable.
- **Recovery.** Anyone may recover a stale operation: a compare-and-set on the generation that was
  read **and** the still-expired lease advances the generation (the old owner can no longer change
  anything) and completes the **stored** decision; a recoverer whose own decision differs gets a 409. `recoveredFrom` keeps the last 20 recovered owners.
- **Failed decisions release the item.** If the stored decision fails deterministically after its
  claim (a precondition changed meanwhile — e.g. the target was merged away, an identity clash
  appeared — or a decision persisted before validation existed), nothing of it was committed: the
  operation becomes `failed` (with `failure.kind` `invalid_decision` / `domain_conflict`), the item
  stays open, its claim is cleared and `lastFailure` tells the operator why. A corrected decision
  claims the item as the next generation. Transient/internal failures are not conflated with
  this: the operation stays claimed (`lastError`) for the owner's resume or a recovery.
- **Outbox.** The retry-intent dispatch (for `retry`), the audit event and the resume of workflows
  waiting on the item are outbox steps, each recorded as delivered. A crash after the item is closed therefore still delivers both,
  exactly once logically: by the owner's retry (the API maps `Idempotency-Key` to the operation
  id), by any later resolver, or by the recovery relay. A workflow node is resumed only while
  `WAITING`, so a repeated resume changes nothing.
- **Recovery relay isolation.** `ReviewService.recoverIncomplete` (run by the hourly
  `market.freshness.sweep`) reads only live operations (`state ∈ {claimed, applied, finalized}`,
  index `by_state_owner_at`, oldest lease first — never the completed/failed history) and
  recovers each one in isolation: a failure is logged, counted
  (`review_recovery_failures_total{kind}`) and recorded on the operation, and the sweep continues.
  A deterministic failure releases the item (it is not retried); a transient one is retried after
  another stale window, so a persistently failing operation cannot starve the others. It then
  runs the retry-intent dispatcher sweep (`ReviewRetryIntents.dispatchStale`): undelivered intents
  untouched for the stale window are dispatched, each in isolation.
- The review item's `claim` field is informational (the UI's RESOLVING state); the operation is
  authoritative.

## Signals

`market_signals` schema, indexes and `GET /api/signals` exist as the seam for follow-on signal
collection; no signal sources are ingested in v0.1.
