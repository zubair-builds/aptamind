# Aptamind Professional Intelligence v0.1 — Context, Requirements and Invariants

- **Status:** Proposed architecture authority for Stream B (Professional v0.1), pending supervisor review
- **Baseline:** Frozen Foundation `foundation-v0.1` = `d9799b6a2ae42a3799b25a1a0f39bb09bd857698`
- **Authentication:** out of scope (ADR-0008); internal/private surface only
- **Companion documents:** [domain model](professional-domain.md) · [PRD](../product/professional-prd.md) ·
  [ADR-0020](../decisions/0020-professional-domain-package.md) · [stream plan](../programme/streams/professional.md)

This document states **what must be true**. The domain document states how it is modelled.
Where this document and a lower authority disagree, this document wins (see `CLAUDE.md`
authority order); where it disagrees with the frozen Foundation or an owner decision, those win.

## 1. Purpose

Professional Intelligence answers four questions about one person (the **subject**):

1. **What is true** about this professional? (canonical profile)
2. **What evidence supports it?** (sources → artifacts → observations → assertions)
3. **What has the professional confirmed** (or rejected)? (confirmation acts)
4. **Which career directions are they targeting?** (career targets)

It does **not** answer: does this person fit this job, can they get this job, which jobs should they
apply to, or how to present them. Those belong to a future Opportunity Intelligence domain, which
will read versioned Professional and Market canonical models through ports wired in the
composition root.

## 2. Product context

```text
Market Intelligence ───────┐
                           ├──> Opportunity Intelligence (not started)
Professional Intelligence ┘
```

- Professional never imports Market and Market never imports Professional (enforced by
  `scripts/check-architecture.ts`). Shared **concepts** travel through `@aptamind/taxonomy`
  (role families, seniority, skills, industries, company stages, work models, countries, regions,
  currencies, languages) and `@aptamind/provenance` (confidence, evidence references), never through
  domain imports.
- **Professional Fit ≠ Application Viability** (owner decision 2026-09-29). Capability evidence
  (experience, skills, education, achievements) is stored and projected separately from
  eligibility facts (work authorization, location, mobility, relocation). Fit must never read
  eligibility; viability combines Professional eligibility with Market employment facts
  (sponsorship, remote scope, authorization requirements) later.

## 3. Inherited architecture laws

All laws of the Market context document (§3) apply unchanged. Their Professional reading:

| Law                          | Professional reading                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A — observation is not truth | A CV line is an observation. Canonical profile items are written only by the reconciler and by confirmation operations.            |
| B — workflow ≠ domain logic  | Precedence, conflict, resolution and extraction policy live in `packages/professional`; workflow specs only compose capabilities.  |
| C — runtime is generic       | No runtime change is required. Professional plugs in through capabilities, service tokens and the `RunLauncher` port.              |
| D — flexible granularity     | `professional.extract_semantic` (AI) and `core.parse_json` share one capability contract.                                          |
| E — durable state in Mongo   | All Professional state is in `professional_*` collections; BullMQ carries wake-ups only.                                           |
| F — idempotency              | Deterministic ids, unique keys, revision/generation fences and replay markers on every write (ADR-0015).                           |
| G — ambiguity is explicit    | `unknown`/`conflicting` item status, `CONFLICTED` assertions, confirmation requests. Unknown stays unknown.                        |
| H — AI cannot mutate truth   | AI outputs are schema-validated observations (proposals) with provider/model/prompt/schema metadata; deterministic policy decides. |

## 4. Professional laws (invariants)

These are non-negotiable for Stream B. Every one has a named test family in the stream plan.

- **PL-1 Confirmed precedence.** Basis order is `confirmed > stated > extracted > inferred`. A
  confirmed value is canonical regardless of how much, how new or how authoritative the
  contradicting evidence is.
- **PL-2 Contradiction is recorded, never silently resolved.** Evidence that contradicts a
  confirmed value creates a `CONFLICTED` assertion, a conflict record and a confirmation request.
  The canonical value does not change until the subject decides.
- **PL-3 Only the subject changes confirmation state.** Transitions into or out of `CONFIRMED`
  and `REJECTED` happen only through a confirmation operation carrying the subject's attestation.
  Extraction, reconciliation, AI, reprocessing and operator data-quality actions cannot perform
  them (enforced by the pure state machine and by state-guarded writes).
- **PL-4 Unconfirmed change is visible.** An unconfirmed canonical value may change only by a
  named precedence rule; every change produces an event and a new profile version with a reason.
- **PL-5 History is never destroyed.** Observations, assertions, confirmations, profile versions,
  career-target versions and events are append-only or state-transitioned, never deleted or
  rewritten by domain operations. (Legal erasure is a separate, explicit, subject-level operation;
  see §9.)
- **PL-6 Absence is not negation.** A newer CV that omits a role, skill or degree is not evidence
  that it is false. Only an explicit subject rejection or an explicit contrary statement counts.
- **PL-7 AI proposes, deterministic code normalizes.** AI output must cite verbatim spans; a
  deterministic span check and deterministic value parsers (dates, languages, countries, skills)
  decide what enters as `extracted`. An unverifiable AI claim is at most `inferred`, low confidence.
- **PL-8 Derived is not asserted.** Totals and projections (years of experience, current role,
  seniority trajectory) are computed from items with their derivation recorded; they are never
  assertions and never need confirmation.
- **PL-9 Fit ≠ viability.** Profile items belong to exactly one section: `identity`,
  `capability`, `preferences` or `eligibility`. Read models expose sections separately; a
  capability projection can never contain eligibility data (schema-tested).
- **PL-10 Privacy by construction.** Opaque subject ids (never derived from PII), private
  artifacts, no PII in logs, metrics labels, workflow run inputs/labels, node inputs/outputs,
  error messages or review reasons; protected characteristics are never extracted.
- **PL-11 Import, never automate.** LinkedIn (and any platform that forbids automation) is
  accepted only as a subject-supplied export file. No login, scraping or fetching of such hosts.
- **PL-12 Cost discipline.** Deterministic extraction first; AI only for semantic segmentation of
  free text; content-hash cache so identical input is never paid for twice; incremental
  extraction per document section.
- **PL-13 Versioned references.** Canonical profile and career targets are addressable as
  `(subjectId, profileVersion)` and `(targetId, targetVersion)` so any future consumer can cite the
  exact version it read.

## 5. Scope

### 5.1 Source types

| Source kind         | Acquisition                             | Authorship       | Default basis of claims                               | Milestone |
| ------------------- | --------------------------------------- | ---------------- | ----------------------------------------------------- | --------- |
| `manual_input`      | structured form via API                 | subject          | `stated`                                              | P1        |
| `questionnaire`     | versioned questionnaire answers via API | subject          | `stated`                                              | P1        |
| `cv`                | upload (PDF, DOCX, TXT, MD)             | subject          | `extracted` (deterministic or span-verified AI)       | P2        |
| `linkedin_export`   | upload of the subject's own export ZIP  | subject/platform | `extracted`                                           | P6        |
| `github`            | public REST API for a stated handle     | platform         | `extracted` (repo facts); `inferred` (skills)         | P6        |
| `portfolio`         | upload or scoped fetch of stated URL    | subject          | `extracted`                                           | P6        |
| `personal_website`  | scoped fetch of stated URL              | subject          | `extracted`                                           | P6        |
| `case_study`        | upload                                  | subject          | `extracted`                                           | P6        |
| `certificate`       | upload (PDF text; no OCR in v0.1)       | issuer           | `extracted` (issuer verification is a seam, not v0.1) | P6        |
| `uploaded_document` | upload (other supporting documents)     | varies           | `extracted`                                           | P6        |

Evidence from a source whose ownership is itself a claim (a GitHub handle, a website URL) is
attributed conditionally: if the subject rejects the ownership claim the source is **disowned** and
its unconfirmed assertions lose that support.

### 5.2 Canonical profile areas

| Area                                         | Section       | Sensitivity                                           | Milestone |
| -------------------------------------------- | ------------- | ----------------------------------------------------- | --------- |
| identity (display name, public links)        | `identity`    | personal                                              | P2        |
| headline / positioning                       | `capability`  | standard                                              | P2        |
| experience: roles and organizations          | `capability`  | standard                                              | P2        |
| skills and tools                             | `capability`  | standard                                              | P2        |
| education, certifications, languages         | `capability`  | standard                                              | P2        |
| location (current city/region/country)       | `eligibility` | sensitive                                             | P2        |
| work authorization (per jurisdiction)        | `eligibility` | sensitive                                             | P2        |
| relocation, mobility                         | `eligibility` | sensitive                                             | P2 / P7   |
| remote preference                            | `preferences` | standard                                              | P2        |
| projects, achievements, portfolio evidence   | `capability`  | standard                                              | P7        |
| domains, industries                          | `capability`  | standard                                              | P7        |
| compensation preferences, career preferences | `preferences` | sensitive                                             | P7        |
| career targets (separate aggregate, §8.7)    | targets       | label/fit standard; viability and rationale sensitive | P5        |

Section (viability vs capability) and sensitivity are **separate axes**. For career targets they
coincide by choice: a target's `fit` part (label, role families, seniority, skills focus, …) is
standard, and its `viability` part (geography — location, relocation, commuting, remote-from —
work models, timezone window, compensation, constraints) and free-text rationale are sensitive
(`include=sensitive`). This includes the remote preference on a target, even though the profile's
own `preference.remote` is standard: on a target it sits with the geography it qualifies.

**Never collected or extracted:** date of birth/age, gender, marital or family status,
ethnicity, religion, health/disability, photographs, national identity/passport numbers, full
street address. Nationality is not collected; work authorization is recorded per jurisdiction
as a status the subject states or confirms.

## 6. Pipeline

```text
Professional Source ─► Raw Artifact / Snapshot ─► Observation (extracted evidence)
   ─► Assertion (proposal) ─► Normalization / Resolution (items) ─► Reconciliation
   ─► User Confirmation ─► Canonical Professional Profile (versioned) ─► Career Targets
```

Confirmation feeds back into reconciliation: a confirmation is itself evidence with basis
`confirmed`. Career targets are a separate aggregate that may be proposed from evidence but
become active only by subject statement or acceptance.

## 7. The claim contract

Every canonical claim must answer, from stored data and without recomputation by the UI:

| Question                        | Answered by                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| What is claimed?                | item (`area`, `itemKey`) + assertion `value` (typed per claim type, taxonomy-coded)           |
| Where did it come from?         | observation → snapshot → source (kind, authorship) → artifact (sha256)                        |
| What evidence?                  | observation `evidence` (artifact id, locator, verbatim quote ≤ 300 chars)                     |
| Extracted or explicitly stated? | observation `mode` (`stated` / `extracted` / `inferred`) and `extractor` (deterministic / ai) |
| User-confirmed?                 | assertion `state = CONFIRMED` + confirmation operation (actor, attestation, time)             |
| Contradicted?                   | item `conflicts[]`, assertion `state = CONFLICTED`, open confirmation request                 |
| Superseded?                     | assertion `state = SUPERSEDED` + `supersededBy` + event                                       |
| Confidence?                     | `confidence` (`@aptamind/provenance` shape: level + reasons; score only with a real basis)    |

## 8. Requirements

### 8.1 Subjects, sources and artifacts

- R-1 A subject is created explicitly with an opaque id (`psub_<ulid>`) and a consent record
  (`dataClass`, `processingBasis`, `aiProcessing`), recorded with the acting `Actor`.
- R-2 Sources are subject-scoped, typed by kind, and carry authorship and acquisition policy.
  Creating the same source twice (same subject, kind and external reference) is idempotent.
- R-3 Raw bytes are stored through the existing content-addressed `ArtifactStore`; a
  `professional_snapshots` record is unique per `(sourceId, contentHash)`. Upload size, page and
  MIME limits are enforced before storage.
- R-4 Professional artifacts are served only through Professional routes that check the owning
  subject; the generic `/api/artifacts/:id/content` must refuse them (Foundation Exception
  candidate FE-P6, composition-layer behaviour change).
- R-5 Source chronology follows ADR-0019: `sourceAsOf` (declared document date, else upload/fetch
  time) orders versions; reprocessing never makes older content newer.

### 8.2 Extraction and observations

- R-6 Observations are append-only; id = hash(snapshot, extractor name@version, claim type,
  locator, normalized payload). Re-running the same extractor on the same snapshot writes nothing new.
- R-7 Each observation records `mode`, `extractor` (`kind`, name, version; for AI also provider,
  model, served model, prompt id/version, schema version, AI operation id), evidence locator and
  quote, confidence and warnings.
- R-8 Deterministic extractors handle all structured sources (manual input, questionnaire,
  LinkedIn export CSVs, GitHub JSON) and deterministic CV features (sections, date ranges,
  taxonomy skills). AI is used only for semantic segmentation of free text (roles, projects,
  achievements, education in prose).
- R-9 AI claims pass: Zod schema validation (gateway) → domain validation → verbatim span check →
  deterministic normalization of values from the quoted text. Failure downgrades or drops the
  claim; it never fabricates a value.
- R-10 A new extractor version supersedes the previous version's observations **for the same
  snapshot** only; other snapshots' evidence is untouched (PL-6).
- R-11 Protected characteristics (§5.2) are dropped by every extractor before persistence and
  are never sent to an AI provider as extraction targets.

### 8.3 Resolution and assertions

- R-12 Observations resolve to **items** (the thing described: one role, one skill, one degree,
  the current location). Keyed items (skills, languages, certifications, work authorization per
  jurisdiction, links, singletons) use deterministic item keys; roles and projects use
  deterministic match rules, and ambiguity becomes a `same_item` confirmation request, never an
  automatic merge.
- R-13 An assertion is one normalized value for one item; identical normalized values from
  several observations share one assertion (corroboration). Assertion states: `PROPOSED`,
  `CONFIRMED`, `REJECTED`, `SUPERSEDED`, `CONFLICTED`, `WITHDRAWN`, with the transition table of the
  domain document enforced by a pure, table-tested state machine.
- R-14 Re-extraction of evidence for a `REJECTED` assertion never reopens it; a newer
  subject-authored source re-stating it opens a confirmation request instead.

### 8.4 Reconciliation

- R-15 Canonical items are recomputed from assertions by a pure, versioned policy
  (`policyVersion`): basis tier → (current-state fields only) source chronology → confidence →
  corroboration. Compatible values merge to the most precise value; incompatible values are
  conflicts. Compatibility rules per value type are golden-tested (date precision, "present",
  title variants, organization aliases).
- R-16 Reconciliation writes are revision-fenced (`rev` compare-and-set, recompute on conflict,
  never re-submit a stale payload) — the B3-R2 pattern.
- R-17 Each change of the profile projection creates an immutable profile version (monotonic per
  subject, content-hash deduplicated) with its cause (reconcile run, confirmation operation).

### 8.5 Confirmation

- R-18 Confirmation requests are deduplicated per question, prioritised by materiality, and
  typed (`confirm_new`, `resolve_conflict`, `reconfirm`, `confirm_change`, `same_item`,
  `accept_target`).
- R-19 A decision (`confirm`, `confirm_with_edit`, `reject`, `mark_outdated`, `revoke`,
  `merge_items`, `keep_separate`, `defer`) is validated before anything is persisted, carries the
  item revision it was made against, and applies all canonical effects in **one transaction**
  whose writes are guarded by that revision and by each assertion's expected state. A stale
  decision gets 409 and changes nothing.
- R-20 The API's `Idempotency-Key` maps to the operation id; a replay returns the stored result;
  the same key with a different decision is 409.
- R-21 Workflows can wait for a request (`ctx.suspend` with the request id as correlation key) and
  are resumed from an outbox step recorded on the operation.
- R-22 v0.1 attestation mode is `operator_relayed` (an internal operator records what the
  subject confirmed). The mode is stored on every confirmation so later subject-direct
  confirmation (after auth) is distinguishable.

### 8.6 History

- R-23 Assertion transitions, confirmations, item merges/splits, source disownment, observation
  quarantine, profile versions and target versions are recorded as events in the same
  transaction as the change, with actor and reason.
- R-24 Every past profile version and target version is retrievable and diffable through the API.

### 8.7 Career targets

- R-25 A subject has any number of simultaneous targets, each with role family (+ specialisations
  and titles), seniority range, geography, work models and remote scope, compensation, industries
  and domains, company stages, employment types, hard/soft constraints, exclusions and a priority.
- R-26 Target vocabulary is taxonomy-coded so a future Opportunity join can compare targets with
  Market jobs without importing Market.
- R-27 Targets are versioned (each edit is a new immutable version, guarded by `rev`); proposals
  derived from evidence stay `proposed` until the subject accepts them.
- R-28 Targets never contain eligibility facts (work authorization, sponsorship need); they
  reference the profile for those.

### 8.8 API and Admin contracts

- R-29 Routes live under `/api/professional/*` in a Professional route module; request/response
  schemas are Zod-validated; lists are server-paginated, sortable and filterable; every mutation
  takes the `Actor` from `resolveActor`.
- R-30 Sensitive sections (`eligibility`, compensation, targets' compensation) are excluded from
  default responses and returned only on explicit `include=sensitive` — the future authorization
  point.
- R-31 Professional publishes `docs/programme/contracts/professional-*.md` for every Admin surface
  it needs and never edits `apps/admin`.

### 8.9 Privacy and security

- R-32 Professional services log ids, counts, enums and error codes only; a child logger adds
  redaction paths (`*.text`, `*.quote`, `*.value`, `*.payload`, `*.email`, `*.phone`, `*.name`) as
  defence in depth.
- R-33 Metrics labels are enums only (source kind, claim type, extractor, outcome); never subject,
  source or item ids.
- R-34 Workflow run inputs, labels, node inputs/outputs and node logs carry opaque ids and counts
  only — never document text, quotes or values (they are persisted and visible in run views).
- R-35 Untrusted documents are parsed with size/page/time limits and no script evaluation;
  fetching uses `SafeHttpClient` with host scope limited to the stated host; LinkedIn hosts are
  refused by the fetch capability.
- R-36 AI extraction runs only if the subject's consent allows it; contact details (emails,
  phone numbers, street addresses) are masked deterministically before text is sent to a provider.
- R-37 A PII canary suite (fixtures with unique canary tokens) asserts that canaries never
  appear in logs, metrics, workflow documents, error messages or review reasons.

### 8.10 Reliability, observability, evaluation

- R-38 Every side-effecting Professional capability declares `key` or `natural` with a written
  proof; an acknowledgement-failure suite shows the final state equals a fault-free run with at
  most one AI call per cache key.
- R-39 Concurrency suites cover: two decisions on one item; decision vs reconciliation; two
  sources of one subject resolving concurrently; target edits with stale revisions.
- R-40 Golden evaluations cover extraction, resolution, assertion reconciliation, confirmation
  precedence and conflict detection and run in `pnpm check`. AI extraction runs against recorded
  fixture responses in CI; a live evaluation is opt-in and reports precision/recall.
- R-41 Data-quality metrics: assertions by state, open conflicts and confirmation backlog age,
  span-verification rate, AI cache hit ratio, AI cost per snapshot.

## 9. Auth, consent and erasure seams

- **Auth.** No auth code. Every mutation takes an `Actor`; subject ownership checks sit in
  one place in the Professional route module (`assertSubjectAccess(actor, subjectId)`, a no-op in
  v0.1) so authorization is added at the edge. A `subject` actor kind is a Foundation Exception
  candidate (FE-P1) needed only when subjects can act directly.
- **Consent.** Stored on the subject; enforced by capabilities (AI extraction, fetching).
- **Erasure.** Domain operations never delete (PL-5). Legal erasure is a distinct subject-level
  operation that must delete Professional documents and artifacts and leave a tombstone. The
  Foundation `ArtifactStore` cannot delete (content-addressed, shared); erasure therefore needs
  FE-P2 before real personal data is processed beyond owner-consented testing. Every Professional
  document carries `subjectId` and every artifact reference is registered in
  `professional_snapshots`/`professional_extractions`, so erasure is implementable without a
  data migration.

## 10. Package boundaries

- New domain package `@aptamind/professional` beside `@aptamind/market`, added to the `DOMAIN`
  set; allow-list: `ai, contracts, db, net, observability, provenance, storage, taxonomy,
workflow-nodes, workflow-sdk, dev:workflows, dev:testing` (identical to Market).
- `eslint.config.js` adds `@aptamind/professional` to the shared-packages restricted imports.
- `packages/platform` registers collections (migration `2026-10-xx-professional-collections`),
  capabilities, AI tasks, workflows, the `PROFESSIONAL` service token and a `labels.subjectId`
  run index — additive registrations allowed by `STREAM_OWNERSHIP.md`.
- `apps/admin` gains `routes/professional.ts`; `apps/worker` needs no code beyond platform wiring.

## 11. Non-goals (v0.1)

Job-fit scoring, ranking, matching, gap analysis, resume/CV generation, cover letters, outreach,
auto-apply, marketplace, employer ATS, candidate agents acting autonomously, LinkedIn automation or
scraping, OCR, deep repository analysis, issuer verification of certificates, authentication,
subject-facing UI, notifications, billing.

## 12. Definition of Done (Professional v0.1)

1. A subject can be created with consent and sources registered for every source kind in §5.1
   that is in P1–P6.
2. Uploads and fetches are preserved as private, content-addressed artifacts; reprocessing uses
   stored snapshots.
3. Structured and CV sources produce append-only observations with evidence spans and extractor
   metadata; AI claims are span-verified and cached by content hash.
4. Observations resolve to items and assertions; role ambiguity creates `same_item` requests.
5. The canonical profile is reconciled with the precedence ladder, conflicts are recorded, and
   every change creates a profile version.
6. Confirmation decisions are idempotent, revision-guarded and replay-safe; confirmed values are
   never changed by automation (adversarial suite).
7. Career targets (multiple, prioritized, versioned, taxonomy-coded) are managed via the API.
8. Capability, preferences and eligibility read models are separate and versioned.
9. PII canary, replay and concurrency suites pass; golden evaluations run in `pnpm check`.
10. Admin contracts are published for subject list/detail, item evidence, confirmation queue,
    source detail, profile versions and targets.
11. No Market import, no frozen-package change without an approved Foundation Exception, no
    auth code.
