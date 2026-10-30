# Aptamind Professional Intelligence — Product Requirements Document v0.1

- **Status:** Proposed (Stream B wave 1)
- **Baseline:** Frozen Foundation `foundation-v0.1` (`d9799b6`)
- **Architecture authority:** [`professional-context-and-requirements.md`](../architecture/professional-context-and-requirements.md)
- **Domain model:** [`professional-domain.md`](../architecture/professional-domain.md) · Decision: [ADR-0020](../decisions/0020-professional-domain-package.md)
- **Delivery plan:** [`docs/programme/streams/professional.md`](../programme/streams/professional.md)

## 1. Product summary

Professional Intelligence builds a **trustworthy, evidence-backed, subject-confirmed model of a
professional**: who they are, what they have done, what supports each claim, what they have
confirmed or rejected, and which career directions they are targeting.

It is the professional-side counterpart of Market Intelligence. Where Market turns external
sources into canonical companies and jobs, Professional turns a person's own material (CV,
structured answers, exports, portfolio, public code, certificates) into a canonical, versioned
profile in which **the person's confirmation outranks any model inference**.

v0.1 is proven through the internal API, workflows and Admin inspection. There is no
subject-facing product and no authentication; internal operators act on the subject's behalf.

## 2. Problem statement

Career data about a person is scattered, inconsistent and partly stale: CVs from different years
disagree on dates and titles, platform exports use their own shapes, portfolios describe work in
prose, and AI summarizers confidently invent details. A system that later reasons about
opportunities for this person needs to know, for every claim, **whether it is true, how we know,
and whether the person agreed** — and must never quietly overwrite what the person told us
because a new document or a model said otherwise.

Specific failure modes this product prevents:

1. A model "improves" a job title or date and it becomes profile truth.
2. An older CV processed after a newer one reverts the current location.
3. A confirmed fact is silently replaced by newly extracted evidence.
4. A trimmed CV (older roles removed) is read as "those roles never happened".
5. Visa status leaks into a skills comparison (fit contaminated by viability).
6. The same role from two sources becomes two roles, or two stints become one.
7. Sensitive personal data spreads into logs, metrics and workflow run records.
8. The same document is re-sent to an AI provider on every retry or reprocess.

## 3. Goals

- **G1 Trustworthy canonical profile.** Every canonical value traces to evidence and states its
  basis (confirmed, stated, extracted, inferred), confidence and conflicts.
- **G2 The subject is the authority.** Confirmation and rejection are explicit, attributable acts;
  confirmed facts are never changed by automation.
- **G3 Change is not contradiction.** The profile evolves over time (new role, new city) with
  full history, while genuine contradictions are surfaced as questions.
- **G4 Multi-source evidence.** CV, structured input, questionnaire, LinkedIn export, GitHub,
  portfolio/website, case studies, certificates and other documents feed one model.
- **G5 Career targets.** Several simultaneous, prioritized, versioned career targets expressed in
  the shared taxonomy.
- **G6 Privacy and cost discipline.** Private artifacts, PII-free operational telemetry,
  data minimization, consent-gated AI, content-hash caching.
- **G7 Ready for Opportunity Intelligence** without doing its job: versioned, sectioned read
  models that keep capability (fit) apart from eligibility (viability).

## 4. Non-goals (v0.1)

Job-fit scoring, ranking or matching; gap analysis; resume/CV or cover-letter generation;
outreach; auto-apply; marketplace; employer ATS; autonomous candidate agents; LinkedIn automation or
scraping; OCR of scanned documents; deep repository analysis; certificate issuer verification;
authentication, permissions and a subject-facing UI; notifications; billing. Professional does not
change `apps/admin`; it publishes contracts that the Admin UX stream implements.

## 5. Actors

### 5.1 Professional Operator (primary, internal)

Onboards a subject with a consent record; registers sources and uploads documents; runs and
monitors ingestion; inspects evidence, assertions and conflicts; relays confirmation questions to
the subject and records their answers; maintains career targets with the subject; handles
data-quality issues (parser failures, suspicious extractions) without touching subject truth.

Needs: to see for any value **why** it is believed; which questions are open and most important;
to record an answer safely even if another operator is working on the same subject; to never be
able to "just fix" a fact on their own authority.

### 5.2 The Professional (the subject)

The person the profile is about and the only authority on confirmation. In v0.1 they interact
through an operator (attestation mode `operator_relayed`). The design keeps the subject as the
decision-maker so direct interaction can be added behind authentication without changing the model.

### 5.3 Secondary consumers

- **Admin UX stream** — implements Professional surfaces from published contracts.
- **Future Opportunity Intelligence** — reads versioned capability, eligibility, preference and
  target read models through a port wired in the composition root.
- **Engineers/evaluators** — golden suites, replay/concurrency suites, data-quality metrics.

## 6. Core concepts

| Concept               | Meaning                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Subject               | The professional; opaque id; consent record                                                                  |
| Source                | Where evidence comes from (kind, authorship, acquisition policy), scoped to one subject                      |
| Snapshot              | Immutable, content-addressed copy of what a source provided at a point in time                               |
| Observation           | One extracted statement with verbatim evidence and extractor metadata; append-only                          |
| Item                  | The thing described — one role, one skill, one degree, the current location                                  |
| Assertion             | One normalized value for one item, with a lifecycle state and supporting observations                       |
| Basis                 | `confirmed > stated > extracted > inferred`                                                                  |
| Conflict              | Incompatible assertions on one item; recorded and surfaced, never silently resolved over confirmed truth    |
| Confirmation request  | A question for the subject (new claim, conflict, reconfirm, change, same item?, accept target)              |
| Decision              | The subject's answer, applied atomically against the item revision that was shown                           |
| Profile version       | Immutable snapshot of the canonical profile after each change                                                |
| Career target         | A direction the subject is pursuing; versioned; prioritized; several at once                                |
| Section               | `identity`, `capability`, `preferences`, `eligibility` — fit reads capability only                          |

## 7. Key workflows

### PWF1 — Onboard a subject

Operator creates a subject with `consent { dataClass: synthetic | owner_consented, processingBasis,
aiProcessing: allowed | denied }` and an opaque reference. **Outcome:** subject exists; no profile
data yet; consent enforced by later steps.

### PWF2 — Ingest a CV

Operator registers a `cv` source and uploads a PDF/DOCX/TXT/MD (optionally declaring the document
date). The ingest workflow stores the snapshot, extracts text and sections, runs deterministic
extraction (sections, date ranges, taxonomy skills), runs AI semantic extraction per section if
consent allows (masked contact details, cached by section hash, span-verified), resolves
observations to items and assertions, and reconciles. **Outcome:** a profile version with roles,
education, skills etc. as `extracted` claims; material items without confirmation get
`confirm_new` requests; conflicts get `resolve_conflict` requests. Re-uploading the identical file
changes nothing and costs no AI call.

### PWF3 — Structured input and questionnaire

Operator submits the subject's answers (manual profile input or a versioned questionnaire).
**Outcome:** `stated` claims that outrank extracted evidence; contradictions with confirmed values
become `reconfirm` requests. Questionnaire answers are not confirmations unless the operator also
records decisions.

### PWF4 — LinkedIn export import

Subject provides their own LinkedIn data export ZIP; operator uploads it. Deterministic mapping of
the export files (profile, positions, education, skills, certifications, languages, projects).
**Outcome:** extracted claims corroborating or conflicting with the CV. Fetching LinkedIn URLs is
refused.

### PWF5 — GitHub, portfolio and website evidence

Operator records the subject's GitHub handle or site URL (itself a claim). Fetch is host-scoped
and bounded. **Outcome:** repository facts as `extracted`, skills from languages as `inferred`
(low), projects and portfolio evidence from pages. If the subject later rejects the handle, the
source is disowned and its unconfirmed claims are withdrawn.

### PWF6 — Confirmation round

Operator opens the confirmation queue (filter by subject, priority), reviews an item's evidence,
asks the subject, and records `confirm`, `confirm_with_edit`, `reject`, `mark_outdated`, `revoke`,
`merge_items`, `keep_separate` or `defer`. **Outcome:** the decision applies atomically if the item
has not changed since it was shown (else 409 and reload); a new profile version records the change;
waiting workflows resume.

### PWF7 — A newer CV arrives

**Outcome:** unchanged sections cost nothing; a role that was "present" and now has an end date
updates without conflict; a moved city replaces an unconfirmed older city with a `confirm_change`
request, but a **confirmed** city stays and a `reconfirm` request is opened; roles omitted from the
newer CV remain.

### PWF8 — Career targets

Operator records one or more targets with the subject (role family, seniority, geography, work
models, compensation, industries, company stages, constraints, priority) or accepts targets
proposed from the subject's stated career intent. **Outcome:** active, prioritized, versioned
targets; every edit is a new version.

### PWF9 — Reprocess after an extractor upgrade

Engineer releases a new extractor version; operator (or a script) reprocesses stored snapshots.
**Outcome:** new observations supersede the old version's for the same snapshots; confirmed values
remain; any newly surfaced disagreement becomes a request; a diff between profile versions shows
exactly what changed and why.

### PWF10 — Inspect history

Operator opens profile versions and diffs, an item's assertion history, or a target's versions.
**Outcome:** nothing that was once believed, confirmed or targeted is lost.

## 8. Functional requirements

Each FR's acceptance criteria are tested in the PR that delivers it (see stream plan).

| FR    | Requirement                                                                                                                         | Acceptance criteria (abridged)                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| FR-P1 | Subjects with consent and opaque ids                                                                                                | idempotent create; consent changes are events; archived subjects reject new sources                                                   |
| FR-P2 | Sources per subject for all §5.1 kinds, with authorship and acquisition policy                                                      | duplicate registration idempotent; LinkedIn source has no fetch; URL sources validated and host-scoped                                |
| FR-P3 | Private, content-addressed snapshots with upload limits and source chronology                                                        | same bytes → same snapshot; oversize/unsupported rejected before storage; generic artifact route refuses Professional artifacts        |
| FR-P4 | Text extraction for PDF/DOCX/HTML/MD/TXT with sections and locators                                                                 | bounded parsing (size/pages/time); no script execution; section hashes stable across identical content                                 |
| FR-P5 | Deterministic extractors for structured sources and CV features                                                                      | golden exact-match for manual input, questionnaire, LinkedIn export, GitHub JSON; protected data dropped                               |
| FR-P6 | AI semantic extraction with schema validation, span verification, deterministic normalization, content-hash cache, consent gating     | fixture-provider golden; unverified spans never `extracted`; replay makes ≤ 1 call per key; skipped when consent denies                |
| FR-P7 | Observations append-only with full provenance                                                                                        | every observation has source, snapshot, artifact, locator, quote, mode, extractor; extractor upgrade supersedes only same snapshot     |
| FR-P8 | Resolution into items and assertions; role matcher; `same_item` requests on ambiguity                                                | resolution golden (promotion, return to employer, alias, fuzzy); concurrent ingest creates no duplicate items                         |
| FR-P9 | Assertion lifecycle state machine with subject-only confirmation transitions                                                         | table test of every transition; mutation test; automation can never write `CONFIRMED`/`REJECTED`                                      |
| FR-P10 | Reconciliation with precedence, compatibility and field classes; revision-fenced                                                    | reconciliation golden; stale reconciler never overwrites a newer decision; equal results commit nothing                               |
| FR-P11 | Profile versions and diffs                                                                                                          | every canonical change creates exactly one version; replay creates none; diffs name items and causes                                  |
| FR-P12 | Confirmation requests: typed, deduplicated, prioritized, auto-closed when moot                                                      | one open request per question; queue sortable by priority/age                                                                        |
| FR-P13 | Decisions: validated before persistence, single transaction guarded by item revision and assertion state, idempotent by key          | concurrency: two decisions on one item → one applies, other 409; key replay returns the same result; different payload → 409          |
| FR-P14 | Workflow wait/resume on confirmation                                                                                                 | a waiting node resumes exactly once after a decision, including after a crash between commit and resume                               |
| FR-P15 | Career targets: multiple, prioritized, versioned, taxonomy-coded, eligibility-free                                                  | stale edit → 409; reorder atomic; versions retrievable; schema has no eligibility fields                                             |
| FR-P16 | Target proposals from stated career intent                                                                                           | proposals stay `proposed` until accepted; evidence linked                                                                             |
| FR-P17 | Sectioned read models (capability, eligibility, preferences, targets) stamped with versions                                         | capability read model cannot contain eligibility fields (schema test)                                                                 |
| FR-P18 | Operator data-quality actions and review queue separate from subject truth                                                          | quarantine changes support and may withdraw assertions, never confirmation state                                                     |
| FR-P19 | Privacy: PII-free logs/metrics/run records; consent-gated AI with contact masking; protected data never extracted                    | PII canary suite passes across ingest, decisions, failures and retries                                                                |
| FR-P20 | Data-quality metrics and dashboard API                                                                                              | assertion states, open conflicts, backlog age, span verification rate, AI cache hit ratio, AI cost per snapshot                        |
| FR-P21 | Paginated, filterable, Zod-validated `/api/professional/*`; sensitive sections only on `include=sensitive`                           | contract tests per endpoint; default responses omit eligibility and compensation                                                      |

## 9. Admin surfaces (contracts published by Professional)

Professional writes these contracts in `docs/programme/contracts/`; Admin UX implements them:
`professional-subject-list`, `professional-subject-detail` (profile by section, completeness, open
requests), `professional-item-detail` (canonical value, assertions, evidence with quotes and
artifact links, conflicts, history), `professional-confirmation-queue` (and decision form
semantics including `expectedItemRev` and 409 handling), `professional-source-detail` (snapshots,
extractions, observations, errors), `professional-profile-versions` (list, diff),
`professional-career-targets` (list, detail, versions, reorder), `professional-data-quality`.
Each states endpoints, schemas by source path, states, actions, errors, permission assumptions
(`include=sensitive`), and basis/confidence/conflict semantics. The UI never derives truth (for
example it never infers a seniority or a work model).

## 10. Success metrics (v0.1 quality bars)

| Metric                                                            | Target                                        |
| ----------------------------------------------------------------- | --------------------------------------------- |
| Deterministic extraction golden (structured sources)              | 100 % exact                                   |
| CV role extraction on golden set (fixture AI + deterministic)     | precision ≥ 0.95, recall ≥ 0.90               |
| AI values classified `extracted` without a verified span          | 0                                             |
| Confirmed values changed by automation (adversarial suite)        | 0                                             |
| Silent canonical changes (change without event + version)         | 0                                             |
| Replay under acknowledgement failure                              | final state = fault-free; ≤ 1 AI call per key |
| AI calls to re-ingest an unchanged CV                             | 0                                             |
| PII canary leaks (logs, metrics, run records, errors)             | 0                                             |
| Item detail API p95 at 500 items per subject (local)              | < 300 ms                                      |

Live AI extraction quality (precision/recall against the golden set with a real provider) is
reported by an opt-in evaluation, not gated in CI.

## 11. Delivery

Milestones P0–P8 and the PR DAG are in the stream plan. Summary: P0 package and contracts; P1
subjects, sources, snapshots and structured input; P2 extraction and assertions; P3
reconciliation and profile versions; P4 confirmation; P5 career targets; P6 more sources (LinkedIn
export, GitHub, portfolio/website, certificates, case studies); P7 remaining profile areas and
read models; P8 hardening and release readiness.

## 12. Risks and mitigations

| Risk                                                       | Mitigation                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| AI hallucinated details become truth                       | span verification, deterministic normalization, `extracted` only with verified spans, confirmation for material claims |
| Over-questioning the subject                               | materiality rules; compatible values merge silently; non-material conflicts wait for area review              |
| Role resolution errors (merging distinct stints)           | conservative matcher; ambiguity → `same_item`; `keep_separate` is sticky; resolution golden                   |
| PII leakage through generic infrastructure                 | ids-only capability IO, redacting child logger, canary suite, private artifact route guard                    |
| Erasure impossible with content-addressed shared artifacts | restrict v0.1 to synthetic/owner-consented data; FE-P2 before real data at scale                              |
| Document parsing vulnerabilities                           | size/page/time limits, no script evaluation, parsing in worker processes                                      |
| AI cost growth                                             | deterministic first, section-level content-hash cache, consent gating, cost metrics per snapshot              |
| Taxonomy is software-centric                               | raw labels kept with `concept: null`; taxonomy additions via FE-P5                                            |

## 13. Open questions for the owner

Only questions that change privacy/legal boundaries (an escalation category in `CLAUDE.md`); each
has a default that v0.1 follows until answered.

1. **Real personal data before erasure exists.** Default: v0.1 processes only synthetic fixtures
   and the owner's own (or explicitly consenting testers') data, recorded as
   `consent.dataClass = owner_consented`, until artifact deletion (FE-P2) and an erasure operation
   exist.
2. **Sending professional documents to the AI provider.** Default: allowed only when the subject's
   consent records `aiProcessing: allowed`; contact details are masked first; otherwise only
   deterministic extraction runs and the gap is visible.
