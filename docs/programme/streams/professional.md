# Stream B — Professional Intelligence v0.1

Branch `professional/v0.1` · worktree `../aptamind-professional` · baseline `foundation-v0.1` (`d9799b6`).
Authority: [context & requirements](../../architecture/professional-context-and-requirements.md) ·
[domain model](../../architecture/professional-domain.md) · [PRD](../../product/professional-prd.md) ·
[ADR-0020](../../decisions/0020-professional-domain-package.md).

**Goal.** A truth/evidence model for a professional: sources ingested, observations extracted,
assertions resolved, confirmed truth represented, canonical profile reconciled and versioned,
career targets represented — without fit scoring, without Market imports, without frozen-package
changes except approved Foundation Exceptions.

## Working rules

- Small PRs to `main`; each carries contract, implementation, tests, docs and migration notes and
  gets two independent reviews. Collections are added by the PR that first writes them.
- Any PR touching canonical truth (assertion states, items, profile versions, decisions, targets)
  includes adversarial, replay (acknowledgement-failure injection) and concurrency tests, and
  mutation checks for the policy it introduces.
- Capability IO carries ids and counts only; every PR extends the PII canary suite to its paths.
- Fixtures are synthetic personas with canary tokens; no real person's data is committed.

## PR DAG

```text
P0.1 ─► P0.2, P0.3
P0.3 ─► P1.1 ─► P1.2 ─► P1.3 (+P0.2)
P1.2 ─► P2.1 ─► P2.2 (+P1.3) ─► P2.3
P1.3 + P0.2 ─► P2.4
P0.2 ─► P3.1;   P3.1 + P2.4 ─► P3.2 ─► P3.3 ─► P4.1 ─► P4.2
P0.3 ─► P5.1;   P5.1 + P4.1 + P2.3 ─► P5.2
P2.4 ─► P6.1;   P2.4 + P4.1 ─► P6.2;   P2.3 ─► P6.3 ─► P6.4
P3.2 + P6.3 ─► P7.1;   P3.2 ─► P7.2;   P7.1 + P7.2 + P5.1 ─► P7.3
all ─► P8.1 ─► P8.2
```

## Milestones and PRs

| PR   | Goal and scope                                                                                                                                                                                                                                     | Acceptance criteria                                                                                                                       | Tests                                                                                                                                                                                                                 | Deps             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| P0.1 | **Package skeleton.** `packages/professional` (facade, context, ports, `PROFESSIONAL` token); `DOMAIN`/`ALLOWED`; ESLint shared-package restriction; platform/api/worker wiring (no collections).                                                  | `pnpm check` green; Market untouched; `check:arch` rejects a Market↔Professional import (negative run recorded in PR).                    | facade unit test; arch negative run                                                                                                                                                                                   | —                |
| P0.2 | **Claim contracts and pure policies.** Claim types (Zod), sections, basis, value types, `transitions.ts` state machine, read-model contracts v1.                                                                                                   | Every transition in the domain table allowed/denied as specified; capability read model schema has no eligibility field.                  | table test of all (from, to, actor) triples; mutation check (flip any row → suite fails); schema tests                                                                                                                | P0.1             |
| P0.3 | **Core collections and migration.** Subjects, sources, snapshots, extractions, observations, events, review items; migration; `labels.subjectId` run index; data-model doc.                                                                        | Validators applied; indexes match specs; migration idempotent.                                                                            | schema-validation integration test (invalid writes rejected server-side)                                                                                                                                              | P0.1             |
| P1.1 | **Subjects and sources API.** Consent record, idempotent create, events, source kinds/policies, `/api/professional/subjects`, `…/sources`; `assertSubjectAccess` seam; publishes `professional-subject-list`.                                      | Duplicate `Idempotency-Key` returns same subject; archived subject rejects sources; LinkedIn source cannot be fetch-enabled.              | API integration tests; PII canary on request logs                                                                                                                                                                     | P0.3             |
| P1.2 | **Snapshots and private artifacts.** Upload with size/MIME/page limits, content addressing, `sourceAsOf`, Professional content route, generic artifact route guard (FE-P6), redacting logger, canary harness.                                      | Same bytes → one snapshot; oversize rejected before storage; generic route refuses Professional artifacts; canaries absent from logs.     | upload integration; concurrent identical uploads; chronology (older doc uploaded later); canary suite                                                                                                                 | P1.1             |
| P1.3 | **Structured input → observations.** Statements endpoint, questionnaire v1, deterministic structured extractor, extraction ledger, `professional.source.ingest` (load → extract_structured).                                                       | Observations carry full provenance; re-ingest writes nothing; publishes `professional-source-detail`.                                     | ack-failure injection after each capability (final state = fault-free); structured golden 100 %                                                                                                                       | P1.2, P0.2       |
| P2.1 | **Document text extraction.** PDF/DOCX/HTML/MD/TXT → normalized text + sections + locators; contact masking; limits; no script evaluation.                                                                                                         | Stable section hashes; bounded time/memory; masked spans recorded.                                                                        | adversarial documents (malformed PDF, DOCX zip bomb, 1,000 pages, script-bearing HTML); masking unit tests                                                                                                            | P1.2             |
| P2.2 | **CV deterministic extraction.** Section classification, date ranges (`present` with `asOf`), taxonomy skills, education/certification heuristics, protected-data filter.                                                                          | Extraction golden passes; protected data never persisted (counted only).                                                                  | extraction golden (8+ synthetic CV shapes); protected-data canaries                                                                                                                                                   | P2.1, P1.3       |
| P2.3 | **AI semantic extraction.** Tasks, consent gating, content-hash AI ledger (per subject), span verification, deterministic value normalization, skip on unavailable.                                                                                | Unverified spans never `extracted`; unchanged CV re-ingest → 0 calls; one changed section → 1 call.                                       | fixture-provider golden; ack-replay (≤ 1 call per key, repeats counted); hallucinated-quote cases; consent-denied skip                                                                                                | P2.2             |
| P2.4 | **Resolution and assertions.** Item keys, role matcher, subject-fenced resolver, assertion upsert, `same_item` requests (stored, surfaced in P3.3).                                                                                                | No duplicate items under concurrency; rejected assertions never reopened by re-extraction.                                                | resolution golden (promotion, return to employer, alias, fuzzy); two sources of one subject resolved concurrently; replay                                                                                             | P1.3, P0.2       |
| P3.1 | **Reconciliation policy (pure).** Compatibility rules, precedence ladder, field classes, conflicts, request derivation, confidence reasons; `policyVersion prof-rec-1`.                                                                            | Reconciliation, precedence and conflict golden pass.                                                                                      | golden suites; mutation checks (reorder ladder, drop a compatibility rule → failures)                                                                                                                                 | P0.2             |
| P3.2 | **Items, profile and versions.** Revision-fenced item reconciler, profile projection, versions and diffs, items/profile/version APIs; publishes `professional-item-detail`, `professional-profile-versions`.                                       | Every change → exactly one version with cause; equal result → nothing written; old snapshot replay never regresses a current-state field. | stale reconciler vs newer write (recompute, never resubmit); A → B → A; reprocess older snapshot after newer; ack-replay                                                                                              | P3.1, P2.4       |
| P3.3 | **Confirmation requests.** Typed requests, materiality, dedupe, auto-close when moot, queue API.                                                                                                                                                   | One open request per question; moot requests closed as `superseded`.                                                                      | concurrent reconcilers opening the same request; replay                                                                                                                                                               | P3.2             |
| P4.1 | **Decision operations.** Validation before persistence, single transaction guarded by item revision and assertion states, idempotency key, outbox + maintenance sweep; operator quarantine endpoints; publishes `professional-confirmation-queue`. | Automation never changes a confirmed value; stale decision → 409 with nothing written; key replay → same result; different payload → 409. | two decisions on one item; decision vs reconciler; decision vs resolver; crash after commit before outbox (sweep completes); adversarial suite: new CV, extractor upgrade, reprocess, quarantine, disown vs confirmed | P3.3             |
| P4.2 | **Wait/resume.** `professional.await_confirmation`; resume from the outbox.                                                                                                                                                                        | A waiting node resumes exactly once.                                                                                                      | crash between commit and resume; duplicate resume                                                                                                                                                                     | P4.1             |
| P5.1 | **Career targets.** Model, versions, status, priority reorder, API; publishes `professional-career-targets`.                                                                                                                                       | Multiple active targets; stale edit → 409; reorder atomic; no eligibility fields.                                                         | concurrent edits/reorders; version history; schema test                                                                                                                                                               | P0.3             |
| P5.2 | **Target proposals.** From `preference.career` and questionnaire (deterministic) and career-intent AI task (fixture); `accept_target` requests.                                                                                                    | Proposals stay `proposed` until accepted; evidence linked.                                                                                | proposal golden; replay                                                                                                                                                                                               | P5.1, P4.1, P2.3 |
| P6.1 | **LinkedIn export import.** ZIP limits, deterministic CSV mapping.                                                                                                                                                                                 | Import-only: fetch of LinkedIn hosts refused for every source kind.                                                                       | export golden; zip-slip/zip-bomb; refusal tests                                                                                                                                                                       | P2.4             |
| P6.2 | **GitHub.** Handle as `identity.link` claim; public API repos; repo facts `extracted`, skills `inferred`; disown path.                                                                                                                             | Rejecting the handle withdraws its unconfirmed claims; confirmed claims stay.                                                             | fixture API responses; rate-limit handling; disown adversarial test                                                                                                                                                   | P2.4, P4.1       |
| P6.3 | **Portfolio and website.** Host-scoped bounded fetch; `document_extract` AI task.                                                                                                                                                                  | Scope enforced; cache and span rules as P2.3.                                                                                             | scope escape attempts; fixture golden                                                                                                                                                                                 | P2.3             |
| P6.4 | **Certificates, case studies, other documents.**                                                                                                                                                                                                   | Issuer recorded; no verification claims.                                                                                                  | extraction golden                                                                                                                                                                                                     | P6.3             |
| P7.1 | **Projects, achievements, portfolio evidence, industries.**                                                                                                                                                                                        | Claim types reconcile under existing policy.                                                                                              | golden additions                                                                                                                                                                                                      | P3.2, P6.3       |
| P7.2 | **Compensation, career preferences, mobility.** Sensitive handling (`include=sensitive`).                                                                                                                                                          | Sensitive data absent from default responses and all logs.                                                                                | API contract tests; canary                                                                                                                                                                                            | P3.2             |
| P7.3 | **Read models and data quality.** Sectioned read models v1 with version stamps; derived views; data-quality metrics API; publishes `professional-data-quality`.                                                                                    | Read models cite `(subjectId, profileVersion)`; metrics labels enum-only.                                                                 | schema separation tests; metrics label test                                                                                                                                                                           | P7.1, P7.2, P5.1 |
| P8.1 | **Hardening.** Full ack-replay and crash suite over every Professional capability; stack-wide canary; 500-item performance check.                                                                                                                  | All suites green in CI.                                                                                                                   | as scoped                                                                                                                                                                                                             | all              |
| P8.2 | **Release readiness.** Runbooks (ingest failure, reprocessing, confirmation backlog), guides, data-model and capability docs, golden gate, status report, `PROGRAMME_STATE.yaml`.                                                                  | Definition of Done §12 of the context doc met with evidence.                                                                              | —                                                                                                                                                                                                                     | P8.1             |

### Acceptance criteria carried from the FE-P6 review (PR #16)

- **P1.2 (R-34 enforcement):** the safety of generic run views (`/api/runs`, `/api/node-runs/:id`,
  run `outputRef`/`outputPreview`) depends on Professional node inputs/outputs carrying ids and
  counts only. P1.2 adds a mechanical guard: a test that fails if any Professional capability's
  input or output schema admits free-text or personal fields (strings other than prefixed ids,
  enums and codes), and a canary run whose node IO, previews and logs must not contain canary
  values. Until FE-P7 lands, no Professional capability may return personal values.
  _Status (P1.2):_ the schema half is in place (`privacy/capability-io.ts` + test, run over
  `professionalCapabilities`, with self-tests that it catches free text, `any`/`unknown`,
  string-keyed records and transforms). The capability list is still empty — the first
  capabilities and workflow (`professional.source.ingest`) land in P1.3, which must add the
  canary run (node IO, previews and logs free of canary values).

### Acceptance criteria carried from the P0 reviews (PR #7)

These are part of the named PRs' acceptance criteria in addition to the table above.

- **P1.1** — [A-NIT-5] Professional error logging redacts MongoDB `errInfo` (server validation
  details can echo document values); a canary test proves a rejected write's values never reach
  logs.
- **P1.2** — [FE-P6] every Professional `ArtifactStore.put` passes `PROFESSIONAL_ARTIFACT_LABELS`
  and every stored artifact is referenced from `professional_snapshots` / `professional_extractions`
  before it is announced; a test uploads through Professional and asserts both generic artifact
  routes answer 404 exactly as for an unknown id. The runtime's `correlationLabels` copies every
  `*Id` run label (`subjectId`, `sourceId`) onto the artifacts it writes (node-output spills,
  record sets, `core.*` nodes), which conflicts with §13 "labels carry no subject id": P1.2 writes
  Professional documents and text directly through `ArtifactStore` with
  `PROFESSIONAL_ARTIFACT_LABELS` (never as runtime artifact outputs), or amends §13 explicitly.
- **P3.1 / P3.2** — [B-H1] assertion revival (`SUPERSEDED → PROPOSED`, domain doc §6), with golden
  and adversarial tests: (a) only `current_state` claim types; `historical`/`set_member` values,
  merge-superseded assertions and assertions of inactive items never revive (reconciler consults
  `canRevive`); (b) only when the new support's `sourceAsOf` is strictly later than the
  superseding winner's (or the subject's `validTo`) — reprocessing an older snapshot after a newer
  one never revives; (c) basis is `confirmed` iff state is `CONFIRMED` (`basisOf`); a revived
  value under a confirmed rival becomes `CONFLICTED` with a `reconfirm` request and the canonical
  value is unchanged; (d) each revival is a recorded transition with an event preserving the prior
  `supersededBy`/`validTo`, and creates a new profile version (A → B → A = three versions).
- **P3.1** (P0 architecture re-review) — [N1] after a **subject** supersession (`mark_outdated`,
  confirm of a rival) revival requires a **declared** document date later than `validTo`; an
  undated (acquisition-time) document never revives: the assertion stays `SUPERSEDED` and a
  `confirm_new` request with reason `outdated_restated` is opened. Revival chronology uses
  `observation.sourceAsOf` (immutable), never the snapshot's moving `sourceAsOf`. Goldens: undated
  old CV after `mark_outdated` → no revival + request; dated newer CV → revival. [N2]
  `revivalGuard(input)` is the only source of the automation write filter for `SUPERSEDED →
PROPOSED` (issued only when `canRevive` allows it); the policy never uses `transitionGuard` for
  revival. [N3] `RevivalInput.supersessionCause` (the cause enum; the stored `supersededBy` is the
  winner's assertion id) and a stored threshold `supersededAtAsOf` captured at supersession time
  (domain doc §15). Doc: revival runs before the active set is computed (§6). — Done in P3.1.
- **P1.3 / P2.4** (from P3.1) — observations record `sourceAsOfKind: declared | acquired` (copied
  from the snapshot at extraction) so the reconciler's support summary can tell declared dates
  (N1); assertions store `supersessionCause` and `supersededAtAsOf` whenever they become
  `SUPERSEDED` (from `PolicyTransition.supersession`, or the decision's `validTo`).
- **P3.2** (from P3.1) — persist `PolicyTransition`s with their `guard` in order; store the
  revival event's `prior` supersession (the event schema needs an additive `details`/`prior`
  field); build the support summary from current observations only (count, modes, distinct
  sources, newest `sourceAsOf`, newest declared and subject-authored `sourceAsOf`, unverified
  spans, plus `withdrawnSupport` = formerly supporting observations no longer current); pass the stored canonical and the item's open requests so `changed`/`keep`/`close` are
  exact.
- **P3.2** (from the P3.1 reviews, Ruling 7) — [B-M2] `changed` means a new profile version;
  `derivedChanged` (confidence or evidence count only) writes the item (revision bump) without a
  version. Apply `supersessionUpdates` with their guards. Support summaries carry `sourceIds`
  (distinct sources are counted as a union across assertions, B-M3), `withdrawnSupport`, and
  CONFIRMED snapshots always carry `confirmedAt` (B-L2; the policy refuses one without).
  [B-M5] no reconcile may observe the state between an extractor-version supersession of a
  snapshot's observations and the resolution of the replacement observations (they would read as
  withdrawn support): either the supersession and the resolution of the new observations commit
  atomically, or reconciliation of the affected items waits until resolution has run (e.g. the
  ingest workflow reconciles only after `resolve_subject`, and the supersession marks affected
  items pending).
- **P4.1** (from the P3.1 reviews, Ruling 5) — decisions implement the answers of domain doc §7.1
  so that each request's condition is removed: "keep" a confirmed value records `reaffirmedAt`
  (optionally rejecting the named challengers); "still rejected" records `rejectionReaffirmedAt`;
  "still outdated" moves the subject supersession's `supersededAtAsOf` (`validTo`); rejecting an
  old value is the subject transition `SUPERSEDED → REJECTED`. Answer goldens: `answer-*` in
  `fixtures/golden/precedence.json`.
- **P4.1** — [B-M5] a `subject`-class transition can only be requested with a branded attestation
  value constructed exclusively inside `confirmation/` (type-level and runtime check); automation
  code cannot obtain one. Confirmation creation uses `confirmationTransition` (`null → CONFIRMED`
  only when no assertion with that `valueKey` exists; `SUPERSEDED → CONFIRMED` restores an older
  value).
- **P5.2** — [B-L4] target proposals never copy eligibility statements (location, work
  authorization, relocation) into a `TargetSpec`; proposal golden includes a career statement that
  mentions visa/location and asserts the spec carries none of it.

- **First schema bump (any PR)** — [N4] Professional validators are closed
  (`additionalProperties: false`), so a rolling deploy must never write a field the running
  validator does not know: widen the validator (collMod) one release before writers use a new
  field, or gate `collMod` on `schemaVersion`; document the chosen procedure in the PR that makes
  the first bump. _Satisfied in P1.2:_ procedure widen → backfill → tighten (domain doc §15,
  supervisor ruling); `acquisitionCount` is the first instance.

### Carried from P1.3

- **P2.4** — observations copy the snapshot's `sourceAsOf` at extraction; the snapshot's
  chronology can move afterwards — a re-acquisition (forms and documents: an `acquired` date moves
  forward) or `snapshot.dated` (documents: acquired → declared). The resolver/reconciler always
  reads the snapshot's **current** `sourceAsOf`, never the observation copy; test both drifts.
- **P2.1** — documents uploaded in P1.3 are recorded `skipped: unsupported_format` by the
  `structured_form` extractor. P2.1 needs a reprocess/backfill plan for them (e.g. a maintenance
  run over snapshots whose only extraction is that skip). The `structured_form` extractor keeps
  skipping documents; the text extractor gets its own name, and P2.2 CV extraction its own
  extractor name too (never a new version of `structured_form`).
- **P2.1 / P3** — [L-5] an extractor version bump re-extracts nothing by itself: snapshots stay
  `processed`/`skipped` with `olderExtractorVersion` (not unprocessed, not auto-launched). A new
  extractor version needs a maintenance/reprocess run over those snapshots, sized and idempotent
  (the ledger is per version).
- **P3 (follow-up)** — [L-6] "acknowledge final failure": a `final` extraction failure
  (`extraction_failed_final`) stays in `counts.unprocessedSnapshots` until acknowledged or a new
  extractor version reads it. Add an operator acknowledgement (event, actor, reason; history kept)
  that removes it from the count without deleting the failed extraction.
- **P2.1** — [M-3 ruling] every doc carrying artifact refs or hashes is presented through a gate:
  `presentExtraction` strips `textArtifact` and section `hash`es without `include=sensitive`;
  P2.1's text extraction must keep that (and never expose ids of hidden observations).
- **P2.3** — [B-L2] consent-dependent skips (`ai_not_permitted`, `ai_unavailable`) must not be
  permanent replay markers: a later consent change or a restored provider must be able to
  re-run the AI extractor for those snapshots (skip markers keyed by consent/provider state, or
  excluded from the replay check).

### Acceptance criteria carried from the P1.2 review (PR #20)

- **Later release (not P1.3's release sequence)** — tighten
  `professional_subjects.acquisitionCount` to required (validator and Zod without default) in the
  first release after P1.2 is deployed everywhere and migration
  `2026-09-30-002-professional-subject-acquisition-count` has run (third step of widen → backfill
  → tighten). P1.2 is not deployed yet, so P1.3 leaves it widened (rollout rule, §15).
- **P1.3** — [B-L2] the first registered Professional capability ships with
  `packages/professional/src/capability-canary.int.test.ts` (a canary run whose node IO, output
  previews and logs contain no canary value); `privacy/capability-io.test.ts` fails without it.
  _Satisfied in P1.3_ (`capability-canary.int.test.ts`; two capabilities registered).
- **P1.3** — upload → ingest contract: whether a re-acquisition (identical bytes) launches a run;
  the status code of an upload that starts a run; a crash between the snapshot commit and the run
  launch leaves a visible "unprocessed snapshot" state and a reprocess path
  (`POST /snapshots/:id/reprocess`). _Decided in P1.3_ (contract `professional-source-detail`):
  201/200 with `runId`; one initial run per snapshot, a re-acquisition returns it;
  `ingest.state: pending` + `counts.unprocessedSnapshots` + reprocess (202).
- **P2.1** — exit criterion: an over-limit DOCX, a PDF whose pages hide in compressed object
  streams, and a zip bomb each end as extraction `skipped` with a code, with parsing time and
  memory bounded (the P1.2 pre-storage page count is PDF-only and may undercount).
- **P3.2** — planning: an explicit operator date-correction action for snapshots (P1.2 only
  converts `acquired` → `declared` on a later declared upload; a different declared date is 409);
  state how `declared` and `acquired` `sourceAsOf` compare in `current_state` precedence.
- **Auth seam** — audit of private-byte reads (`GET /snapshots/:id/content`: who read which
  snapshot) and per-actor Idempotency-Key scoping.
- **P1.3 / P6** — [N5] structured sources (manual input and questionnaire forms, LinkedIn CSV
  cells, GitHub JSON fields, deterministic CV fields) produce `extracted`/`stated` observations
  whose `evidence.quote` is the cell/field text and `spanVerified: true` by construction; tests
  show the quote equals the stored cell.

Wave mapping: wave 2 = P0.\*, P1.\*; wave 3 = P2.\*; wave 4 = P3.\*, P4.\*; wave 5 = P5–P8. P3.1
and P5.1 can run in parallel with P2.

## P3.1 decisions (policy `prof-rec-1`)

For the decision log (supervisor): ambiguities in the domain doc resolved by P3.1.

- **Older current-state evidence under a confirmed value is history, not a challenge.** With a
  `CONFIRMED` current-state value, an incompatible unconfirmed value whose newest support is not
  newer than the confirmation (`confirmedAt`, or the confirmed value's newest support) is
  `SUPERSEDED` (`older_than_confirmed`), not `CONFLICTED`; newer evidence is a challenge
  (`CONFLICTED` + `reconfirm`). Historical and set-member values are always challenges.
- **Materiality gates every reconciler request except `reconfirm`** and the subject-restatement
  questions (`rejected_restated`, `outdated_restated`), and is per attribute inside material
  composites (role employment type/workplace, certification URL, education field are immaterial).
- **Lower-tier compatible, more precise values are refinements (suggestions), not merged**, in the
  unconfirmed branch as in the confirmed branch; only values of the winning tier merge.
- **Same-date disagreement in the winning tier of a current-state field is a `same_basis`
  conflict** (status `conflicting`): chronology cannot decide and assertion ids never do.
- **`confirm_change` is derived from state** (stored canonical value superseded by the new winner;
  kept while it stands), so a recompute is a fixed point; A → B → A reuses one
  `confirm_change:{A,B}` key (ids are sorted by definition of the dedupe key).
- **Compatibility additions** beyond the §3.3 table: text is compared case/accent/punctuation-
  insensitively; `unknown` tri-state/education status is absence; education `in_progress` ~
  `completed`; historical lists (project technologies, achievement metrics) are subset-compatible;
  skill/language/industry compare by taxonomy code when both have one, else by normalized label.
- **Canonical `changed`** includes conflicts, refinements and per-attribute status (a new conflict
  on an item is a new profile version); confidence alone is not a change.
- **Withdrawn chronology winner (supervisor ruling on the former open question).** If the
  assertion that superseded X by chronology (cause `newer_state`; not a subject decision, not a
  merge) later has no current support (withdrawn, quarantined), X is a revival candidate
  regardless of dates — the basis for its supersession no longer exists. Revival still goes only to
  `PROPOSED` via `revivalGuard`, never after a subject supersession, never for merges, never for
  historical/set-member values. After a subject supersession whose confirmed winner lost all its
  support, X does not revive; a `reconfirm` request (`superseder_withdrawn`) is opened instead.
  Goldens: `winner-quarantined-older-value-revives`,
  `subject-superseded-value-with-winner-quarantined-does-not-revive` (both with mutation checks).
  The support summary gains `withdrawnSupport` (formerly supporting observations no longer
  current) so "lost its support" is distinguishable from "never had any" (`confirm_with_edit`).

### P3.1 review rulings (PR #14, both reviews)

Supervisor rulings applied on `professional/p3-policy`; each has goldens that reproduce the
reviewer's sequence (failing before, passing after) and mutation checks.

- **Ruling 1 — supersession validity** (A-H1, A-M2, A-M3, B-H2): stored supersessions are
  re-evaluated every recompute (`supersessionHolds`). `newer_state` holds only while the superseder
  is not REJECTED and still has the chronology that won; older values under a confirmed value have
  their own cause `confirmed_rival` — revived when the rival is revoked, kept (and
  `confirm_new/current_unknown` asked when nothing active remains) when the rival is marked
  outdated; a superseder rejected in a confirm_change lets the older value revive. When the
  confirmed value's chronology shrinks, older values are re-evaluated (`supersessionUpdates`).
- **Ruling 2 — decisions are not undone through a compatible value** (A-H2): see domain doc §6
  step 2 (`subject_decision` hold, `contradicts_decision` conflict, restatement requests).
- **Ruling 3 — pairwise winning tier** (B-H1, A-M1, L3) with an id-permutation property test (T1).
- **Ruling 4 — immaterial disagreement keeps the item known** (B-H4).
- **Ruling 5 — answerability** (B-H3, A-M5, A-L2, B-L5, A-L1): `SUPERSEDED → REJECTED` (subject);
  reaffirmation timestamps; legal answers per reason in domain doc §7.1 (P4.1 criterion above);
  dedupe key includes the reason; request roles; confirm_new names the canonical assertion.
- **Ruling 6 — compatibility** (A-M4, B-L6, A-L4): `+`/`#` are words (C++ ≠ C#); explicitly
  differing seniority/role family conflict; `validUntil` compares exactly; education progress is
  chronology-aware.
- **Ruling 7 — P3.2 seams** (B-M1..M5, B-L2, B-L4): `canonical.attributes` and
  `supportingAssertionIds` documented (§14/§15); `derivedChanged`; distinct `sourceIds`;
  `confirmedAt` required for CONFIRMED; deterministic representative (precision, chronology,
  value); restatement in every field class; P3.2 criterion for extractor supersession vs
  resolution atomicity.
- **Tests** (A-T2..T4): subject decisions in the property generators and a coarse + two-precise
  cities pool (which found an order dependence in revival, fixed by iterating revival to a fixed
  point); REJECTED property asserts the canonical value; stricter purity regex; simulator evaluates
  `$nin` and routes confirm-of-existing through the transition check.
- **Re-review Mediums** (A-MedA = B-N2, A-MedB + B-N1, A L-a..c): the declared-date escape from a
  Ruling 2 hold applies to current_state only (historical/set-member holds ask via
  `rejected_restated`/`outdated_restated`); a rejection holds only values at least as precise as
  the rejected one (marked-outdated values keep holding any compatible value); a material item left
  `unknown` by a hold asks `confirm_new/held_by_decision`; `current_unknown` also follows a revoke;
  `defer` is the "don't know" answer; `{FR}` + Paris + Lyon in the current-state property pool.
- **Deferred to P3.2** (B Low): an older, more precise current-state value under a newer coarse
  winner (Berlin 2022 under DE 2024) currently merges into the canonical value; presenting it as a
  refinement (suggestion) instead changes current-state semantics and is left for P3.2 to decide.
- **Deferred** (B-L8): batching requests per area (one question per item area instead of per
  item) → P4 / API.

### P5.1 — career targets (implementation notes)

- Branch `professional/p5-targets` from `origin/main` (P1.1 subjects); no dependency on the
  unmerged P1.2/P1.3 (#20/#24) or P3.1 (#14). Contract:
  [`professional-career-targets`](../contracts/professional-career-targets.md).
- **Fit ≠ viability in the spec** (INTEGRATION_CONTRACTS §4): `TargetSpec` is `{ label, fit,
viability, rationale? }`; `fit` = role families, specializations, titles, seniority, skills
  focus, industries/domains, company stages, employment types; `viability` = geography (location,
  relocation, commuting, remote-from), work models, timezone window, compensation, constraints.
  `CareerTargetsV1` carries `label` + `fit` only; `CareerTargetViabilityV1` the viability part.
  Work authorization / sponsorship / visa do not exist in targets (R-28), also server-side.
- **Sensitive off by default** (DECISION_LOG, PR #24 ruling): viability and the free-text
  rationale are omitted unless `include=sensitive`, on every read (list, detail, versions,
  diffs); writing them requires it too.
- **Precedence:** stated/accepted targets are `basis: confirmed`; proposals (P5.2) `inferred`;
  automation actors may only propose and edit their own proposals while `proposed`
  (`targets/transitions.ts`, table-tested).
- **Schema / deploy:** two new collections (`professional_career_targets`,
  `professional_career_target_versions`) with closed validators (every nested object closed;
  `priority`/`version` ≥ 1). `professional_subjects` gains the optional `targetsRev` fence field
  (widen only; readers default 0). `targetsRev` stays optional **permanently**: it is a fence,
  not data, so there is no tighten step (and no backfill migration). Deploy drain-first
  (DECISION_LOG). Collection versions (#20, done at the `main` merge, supervisor A-L4):
  `professional_subjects` 3 → 4, `professional_career_targets` and
  `professional_career_target_versions` registered at 1 (fingerprints appended in
  `collections.test.ts`), so a late pre-P5.1 (P1.2+) process skips re-applying its closed
  `professional_subjects` validator; a P1.1 process is not covered, so drain-first still matters.
  **Rollback past P5.1:** stop the P5.1 processes, then run
  `db.professional_subjects.updateMany({ targetsRev: { $exists: true } }, { $unset: { targetsRev: '' } })`
  before starting any older process (the older validator refuses subject documents that carry
  `targetsRev`); the target collections can stay (older processes ignore them).
- **PR #26 review rulings:** automation never overwrites the subject's input — a subject edit of a
  proposal keeps it `proposed` but sets `subjectEdited`, after which automation edits are
  refused, and automation may edit only proposals it created (`createdBy`); the 100 cap counts
  open targets only (proposed, active, paused); the list returns open targets by default and
  pages `status=archived|declined|all` history (R-29); versions are paged (default 50); `rev` is
  checked before legality (stale → 409); `fitHash` over `label` + `fit` is the drift pin;
  `targetsRev` is stripped from subject responses; the subject overview counts open targets.
- **Deferred:** proposals and `accept_target` requests (P5.2), including a separate cap on open
  proposals (P5.2); read-model endpoints (P7.3).

## Evaluation strategy

- **Golden suites** in `packages/professional/fixtures/golden/`, run by
  `pnpm --filter @aptamind/professional eval:golden` and from the root `eval:golden` (in `pnpm check`):
  - _extraction_ — synthetic CVs (chronological, functional, two-column text order, "present",
    overlapping roles, career gap, promotion at one employer, freelance with several clients,
    education in progress, non-English month names) and structured inputs; expected observations
    per claim type; deterministic extractors exact, AI via recorded fixture responses (exact).
  - _resolution_ — same role vs promotion vs return to employer; aliases; fuzzy → `same_item`.
  - _assertion reconciliation_ — basis tiers, current-state chronology, compatible refinement
    (`2019` ~ `2019-03`, `present(asOf)` vs later end), set membership and absence.
  - _confirmation precedence_ — event sequences (extract → confirm → newer CV → reprocess → reject
    → restate) with expected final assertion states, canonical values and open requests.
  - _conflict detection_ — compatible/incompatible pairs per value type, including false-conflict
    traps (title abbreviations, legal-form suffixes) and true conflicts (disjoint dates).
- **Opt-in live AI evaluation** (`eval:professional:live`, needs credentials): precision/recall per
  claim type, span-verification rate, cost per CV. Reported in PRs, not a CI gate.
- **Mutation checks** for `transitions.ts`, the precedence ladder and compatibility rules.
- **Replay/concurrency** suites as listed per PR; **PII canary** suite grows with every PR.

## Admin UI contracts to publish (`docs/programme/contracts/`)

`professional-subject-list` (P1.1) · `professional-source-detail` (P1.3) ·
`professional-item-detail` and `professional-profile-versions` (P3.2) ·
`professional-confirmation-queue` incl. decision form, `expectedItemRev` and 409 handling (P3.3/P4.1) ·
[`professional-career-targets`](../contracts/professional-career-targets.md) (P5.1, published) · `professional-subject-detail` by section (P3.2, extended P7.3) ·
`professional-data-quality` (P7.3). The item-detail contract (P3.2) presents `contradicts_decision`
conflicts as "held by subject decision", and `current_unknown` offers "don't know" (`defer`). Each states endpoints, schemas by source path, states, actions,
errors, `include=sensitive`, and basis/confidence/conflict semantics. Admin UX implements them.

## Foundation Exception candidates

| Id    | Package                    | Change                                                                                                                                                                                                                                                        | Needed by                                | v0.1 workaround                                                                       |
| ----- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| FE-P6 | `apps/admin` (composition) | generic `/api/artifacts/:id(/content)` refuses artifacts owned by a private domain                                                                                                                                                                            | P1.2                                     | none acceptable for private artifacts; small, additive-looking but behaviour-changing |
| FE-P2 | `storage`                  | artifact deletion with per-domain reference registry (erasure; content-addressed sharing); must also sweep Professional-labelled artifacts no snapshot/extraction references (orphans of failed uploads) and reference-count artifacts shared across subjects | real personal data beyond testing        | restrict to synthetic/owner-consented data                                            |
| FE-P1 | `contracts`                | `subject` actor kind (and on-behalf-of) in `actorSchema`                                                                                                                                                                                                      | subject-direct access (post-auth)        | `attestation.mode = operator_relayed` on decisions                                    |
| FE-P4 | `provenance`               | subject tiers (`subject_confirmed`, `subject_stated`) in `AUTHORITY_TIERS`                                                                                                                                                                                    | uniform evidence view for Opportunity    | Professional `basis` field and own precedence function                                |
| FE-P5 | `taxonomy`                 | shared organization-name key; non-software skills/roles vocabulary                                                                                                                                                                                            | better Market join, non-tech professions | raw labels kept, `concept: null`; local org key with documented algorithm             |
| FE-P3 | `ai`                       | expose the requested `model` on `AiGateway`                                                                                                                                                                                                                   | cache keys without extra config          | platform passes `config.ai.model` into `ProfessionalContext`                          |

Only FE-P6 is required inside v0.1; it will be written as `foundation-exceptions/FE-P6.md` before P1.2.

## Open owner questions

Real personal data before erasure exists, and sending documents to the AI provider — see PRD §13
(defaults apply until answered).

## Supervisor review (Wave 1)

- Accepted; ADR-0020 accepted. Reviewed against Foundation invariants (observation-first,
  AI proposes / policy decides, revision-fenced canonical writes, replay safety), the owner's
  Professional rules (confirmed truth outranks inference; conflicts surfaced; history kept), Market
  boundaries (no imports; shared concepts only) and the Opportunity seam (sectioned read models;
  eligibility never in the capability view; targets carry no visa/sponsorship).
- FE-P6 (generic artifact route must refuse Professional artifacts) is approved as a Foundation
  Exception in the composition layer; it ships as its own small PR before P1.2 with the record
  `docs/programme/foundation-exceptions/FE-P6.md`. FE-P2 is required before any real personal
  data; FE-P1/P3/P4/P5 stay deferred behind their stream-local workarounds.
- Privacy/legal questions (real personal data before erasure exists; sending documents to the AI
  provider) are escalated to the owner as non-blocking: v0.1 proceeds on the safe defaults —
  synthetic fixtures only, AI only with recorded `aiProcessing: allowed` consent and contact
  masking.
- Execution: P0.1 → P0.2 ∥ P0.3 → P1.1 → FE-P6 → P1.2 → P1.3; P3.1 and P5.1 may start in parallel
  once P0.2/P0.3 land.
