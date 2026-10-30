# Professional domain

`packages/professional` (`@aptamind/professional`) owns the meaning of Professional Intelligence:
what is true about a professional (the **subject**), what supports it, what the subject confirmed,
and which career directions they target. It is exposed to workflows as `professional.*`
capabilities and to the API through the `ProfessionalDomain` facade, and depends on the runtime
only through capabilities and narrow ports. Requirements and invariants (PL-1 … PL-13, R-1 …
R-41) are in [professional-context-and-requirements.md](professional-context-and-requirements.md);
the package decision is [ADR-0020](../decisions/0020-professional-domain-package.md).

Status: **in implementation**. Landed: P0 (package, claim contracts, state machine, core
collections) and P1.1 (subjects and sources API); P3.1 (pure reconciliation policy `prof-rec-1`)
is in code. The PR DAG is in
[`docs/programme/streams/professional.md`](../programme/streams/professional.md).

## 1. Pipeline and modules

```text
Source ─► Snapshot ─► Extraction ─► Observation ─► Resolution ─► Assertion ─► Reconciliation ─► Item / Profile ─► Version
(psrc)    (psnap,     (pext: text,   (pobs, append-  (item keys,   (pasr,       (pure policy,      (pitm canonical,   (ppv)
          artifact)    sections)      only)           role match)   lifecycle)   rev-fenced)        ppro projection)
                                                                        ▲                 │
                                        Confirmation operation (pcop) ──┘   Confirmation requests (pcrq)
Career targets (ptgt, ptgv) — separate aggregate; proposals from evidence, activation by the subject.
```

| Module (`src/…`)  | Responsibility                                                                                | Kind                   |
| ----------------- | --------------------------------------------------------------------------------------------- | ---------------------- |
| `contracts/`      | claim types, value schemas, sections, basis, read-model contracts (exported as `./contracts`) | pure                   |
| `subjects/`       | subject lifecycle and consent                                                                 | persistence            |
| `sources/`        | sources, snapshots, upload limits, private artifact access, fetch policy                      | persistence / I/O      |
| `text/`           | PDF/DOCX/HTML/MD/TXT → normalized text + section map; contact masking                         | pure (bounded parsing) |
| `extraction/`     | deterministic extractors per source kind; AI tasks; span verification; protected-data filter  | pure + AI port         |
| `observations/`   | observation store, supersession, quarantine                                                   | persistence            |
| `resolution/`     | item keys, role/project matcher, subject-fenced resolution                                    | pure policy + store    |
| `assertions/`     | assertion store; **state machine** (`transitions.ts`, table-tested)                           | pure + persistence     |
| `reconciliation/` | compatibility rules, precedence policy (`policy.ts`), item reconciler (rev-fenced)            | pure + persistence     |
| `profile/`        | projection, derived views, versions, diffs, sectioned read models                             | persistence            |
| `confirmation/`   | requests, decision validation, single-transaction operation, outbox relay                     | persistence            |
| `targets/`        | career targets and versions                                                                   | persistence            |
| `events/`         | append-only event ledger                                                                      | persistence            |
| `review/`         | operator data-quality queue (not subject truth)                                               | persistence            |
| `privacy/`        | redacting child logger, id-only output helpers, canary utilities for tests                    | pure                   |
| `workflow-nodes/` | `professional.*` capabilities                                                                 | adapters               |
| `workflows/`      | workflow specs                                                                                | specs                  |
| `golden/`         | golden evaluators and runner (`eval:golden`)                                                  | test                   |

`ProfessionalContext = { db, clock, logger, artifacts, config: { aiModel, limits } }`. Ports:
`RunLauncher` (start runs), `WorkflowResumer` (`resumeByCorrelationKey`) — the same shapes Market
uses, wired by `packages/platform`. The logger is a pino child with extra redaction paths (R-32).

## 2. Identifiers

All ids are prefixed and opaque. **No id is derived from a bare personal identifier** (a hash of
an email, name, handle or URL is linkable personal data). Deterministic ids hash opaque ids, enum
keys, and content hashes that are always scoped by an opaque id (snapshot bytes, observation
payload, prompt input). Where uniqueness depends on a personal value (a GitHub handle, a link URL),
the id is random and idempotency comes from a unique index on `(subjectId, …)`: an insert that
hits the index returns the existing document.

| Entity                  | Prefix          | Id rule                                                                                                                          |
| ----------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Subject                 | `psub`          | `newId` (ULID); API `Idempotency-Key` → `det(psub, 'idem', key)`                                                                 |
| Source                  | `psrc`          | `newId`, unique `(subjectId, kind, externalRefKey)` when an external ref exists; API key → `det(subjectId, 'idem', key)`         |
| Snapshot                | `psnap`         | `newId` (random: an id derived from content would be a hash oracle); unique `(sourceId, contentHash)` de-duplicates internally   |
| Acquisition             | `pacq`          | `newId` per accepted upload; API `Idempotency-Key` → `det(sourceId, 'idem', key)` (`professional_acquisitions` ledger row)       |
| Extraction              | `pext`          | `det(snapshotId, extractorName, extractorVersion)`                                                                               |
| AI extraction (cache)   | `paix`          | `det(subjectId, task, promptId@version, schemaVersion, model, inputHash)`                                                        |
| Observation             | `pobs`          | `det(snapshotId, extractorName@version, claimType, locator, payloadHash)`                                                        |
| Item                    | `pitm`          | keyed: `newId` via upsert on unique `(subjectId, itemKey)`; matched (role, project): `det(subjectId, area, anchorObservationId)` |
| Assertion               | `pasr`          | `det(itemId, valueKey)` (`valueKey` = hash of the comparable normalized value)                                                   |
| Profile                 | `ppro`          | `det(subjectId)`                                                                                                                 |
| Profile version         | `ppv`           | `det(subjectId, version)`                                                                                                        |
| Confirmation request    | `pcrq`          | `newId`; one open request per `(subjectId, dedupeKey)` (unique partial index)                                                    |
| Confirmation operation  | `pcop`          | `det(subjectId, idempotencyKey)`                                                                                                 |
| Career target / version | `ptgt` / `ptgv` | `det(subjectId, 'idem', key)`; proposals `det(subjectId, 'proposal', evidence ids)` / `det(targetId, version)`                   |
| Event                   | `pevt`          | `det(operationId \| runId, entity, seq)`, written with `$setOnInsert`                                                            |
| Review item             | `prvw`          | `newId`; one open item per `dedupeKey`                                                                                           |

## 3. Claim model

### 3.1 Basis, mode and sections

- **Mode** of an observation: `stated` (subject-authored structured value: form, questionnaire),
  `extracted` (value supported by a verbatim span of a source), `inferred` (derived without a
  verbatim statement: skill from repository languages, seniority from a title, unverifiable AI
  claim).
- **Basis** of an assertion: `confirmed` **iff** its state is `CONFIRMED` (never because a
  confirmation record exists — a superseded, revoked or rejected assertion keeps its confirmation
  history but is not confirmed), else the best mode of its current supporting observations. Precedence (PL-1): `confirmed` (4) > `stated` (3) >
  `extracted` (2) > `inferred` (1).
- **Section** of every claim type: `identity`, `capability`, `preferences`, `eligibility`
  (PL-9). **Sensitivity**: `standard`, `personal`, `sensitive`.
- **Field class** decides how chronology is used:
  - `current_state` — a value that legitimately changes over time (headline, current location,
    remote preference, relocation willingness, compensation expectation). A newer source may
    replace an older **unconfirmed** value.
  - `historical` — a fact about the past (role dates and titles, degree, certification issue date).
    Chronology never decides; disagreement is a conflict.
  - `set_member` — membership of an open set (skills, tools, languages, links, industries). Each
    member is its own item; absence never removes a member (PL-6); attributes (e.g. proficiency)
    reconcile as `historical`.

### 3.2 Claim types (v1)

Values use `@aptamind/taxonomy` codes where a vocabulary exists; the raw label is always kept,
and an unmatched concept is `null`, never dropped or guessed.

| Claim type                | Section     | Class         | Item key                                  | Normalized value (abridged)                                                                                                                                      | Milestone |
| ------------------------- | ----------- | ------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `identity.name`           | identity    | current_state | `identity.name`                           | `{ display, preferred? }`                                                                                                                                        | P2        |
| `identity.link`           | identity    | set_member    | `link:<kind>:<normalized url/handle>`     | `{ kind: website\|github\|linkedin\|portfolio\|other, url }`                                                                                                     | P2        |
| `positioning.headline`    | capability  | current_state | `positioning.headline`                    | `{ text }`                                                                                                                                                       | P2        |
| `experience.role`         | capability  | historical    | matched (§4.2)                            | `{ organization{name,key,url?}, title, titleKey, roleFamily?, seniority?, employmentType?, start, end \| present, location? }`                                   | P2        |
| `skill`                   | capability  | set_member    | `skill:<concept \| labelKey>`             | `{ label, concept?, category?, kind: skill\|tool, proficiency? (only if stated), context: listed\|used_in_role\|repo }`                                          | P2        |
| `education`               | capability  | historical    | `edu:<institutionKey>:<qualificationKey>` | `{ institution{name,key}, qualification, field?, level?, start?, end?, status: completed\|in_progress\|unknown }`                                                | P2        |
| `certification`           | capability  | historical    | `cert:<issuerKey>:<nameKey>`              | `{ name, issuer, issued?, expires?, url? }`                                                                                                                      | P2        |
| `language`                | capability  | set_member    | `lang:<code>`                             | `{ language (taxonomy), proficiency: native\|fluent\|professional\|basic\|cefr:<A1–C2> }`                                                                        | P2        |
| `location.current`        | eligibility | current_state | `location.current`                        | `{ city?, region?, country (ISO 3166-1 alpha-2) }`                                                                                                               | P2        |
| `work_authorization`      | eligibility | historical\*  | `workauth:<jurisdiction>`                 | `{ jurisdiction (country or region code), status: citizen_or_equivalent\|permanent\|visa\|none, visaType?, validUntil?, sponsorshipRequired: yes\|no\|unknown }` | P2        |
| `mobility.relocation`     | eligibility | current_state | `mobility.relocation`                     | `{ willing: yes\|no\|conditional, destinations[] }`                                                                                                              | P2        |
| `preference.remote`       | preferences | current_state | `preference.remote`                       | `{ acceptable: WorkModel[], preferred?: WorkModel, timezoneWindow? }`                                                                                            | P2        |
| `project`                 | capability  | historical    | matched                                   | `{ name, role?, period?, url?, technologies[], summaryRef }`                                                                                                     | P7        |
| `achievement`             | capability  | historical    | `ach:<roleOrProjectItemId>:<textKey>`     | `{ text, metrics[{ value, unit, quote }] }`                                                                                                                      | P7        |
| `portfolio.evidence`      | capability  | set_member    | `pf:<normalized url \| artifactId>`       | `{ kind: case_study\|repository\|publication\|talk\|design_file, title, url?, relatesTo[] }`                                                                     | P7        |
| `domain` / `industry`     | capability  | set_member    | `ind:<code \| labelKey>`                  | `{ label, code? (taxonomy INDUSTRIES) }`                                                                                                                         | P7        |
| `preference.compensation` | preferences | current_state | `preference.compensation`                 | `{ currency, min?, target?, period, basis }` (no value is ever inferred)                                                                                         | P7        |
| `preference.career`       | preferences | current_state | `preference.career`                       | `{ statementRef }` (seeds target proposals)                                                                                                                      | P5        |

\* Work authorization has an expiry; it is `historical` for conflicts but a `validUntil` in the
past makes the canonical status `expired` without changing any assertion.

Dates are `{ year, month? }` with explicit precision; `present` is stored as `{ open: true, asOf:
sourceAsOf }` — "still true when the source was written", never "still true today".

**Protected data filter.** Every extractor runs a deny-list before persistence (date of
birth/age, gender, marital status, nationality, ethnicity, religion, health, photo, national id,
street address). Dropped counts are recorded on the extraction (`protectedDropped`), the content
never is.

### 3.3 Compatibility (not equality)

Two assertions on one item are **compatible** if one can be true together with the other.
Compatible values merge to the most precise one; incompatible values are conflicts. Rules are
pure (`reconciliation/compatibility.ts`), versioned and golden-tested:

| Value (rule name)                                 | Compatible when                                                                                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| date (`date_precision`)                           | equal at the coarser precision (`2019` ~ `2019-03`)                                                                                                                                 |
| end date vs `present` (`present_vs_end`)          | the dated end is ≥ the `present` observation's `asOf` month (old CV "present", new CV ended later)                                                                                  |
| title (`title_normalization`)                     | equal `titleKey` after abbreviation/seniority-word normalization (`Sr.` ~ `Senior`); explicitly differing seniority or role family conflict; otherwise a conflict on the title only |
| organization (`organization_legal_form`/`_alias`) | equal key after legal-form stripping, or a recorded alias; fuzzy similarity alone is never compatibility (→ `same_item`)                                                            |
| skill proficiency (`optional_absent`)             | equal, or one side absent                                                                                                                                                           |
| location (`place_partial`)                        | same country and (same city or one city absent)                                                                                                                                     |
| work authorization (`tri_state_unknown`)          | same status and visa type; differing `validUntil` → conflict; `sponsorshipRequired: unknown` is absence                                                                             |
| education status (`education_progress`)           | `in_progress` then a later `completed` is compatible; `completed` then a later `in_progress` conflicts; `unknown` is absence                                                        |
| historical lists (`list_subset`)                  | project technologies, achievement metrics: one list contains the other                                                                                                              |
| text (`text_normalization`)                       | equal ignoring case, accents, punctuation and whitespace (`B.Sc.` ~ `BSc`; `+`/`#` are words, so `C++` ≠ `C#`)                                                                      |

Each rule is named in `reconciliation/compatibility.ts` (`COMPATIBILITY_RULES`); attribute specs per
claim type (`ATTRIBUTE_SPECS`) say which rule compares which attribute and which attributes are
material. Current-state lists (`preference.remote.acceptable`, relocation destinations) compare as
sets (order-insensitive, no subset rule). A mutation test drops each rule in turn and a named
golden case must fail.

**Composite values** (roles, education, certifications, projects). An assertion carries the whole
normalized record, because the subject confirms or rejects what they are shown. Compatibility
and canonical status are computed **per attribute**: the item's canonical value is a record of
per-attribute facts, so a title disagreement makes only the title `conflicting`, not the dates.
Confirming a composite assertion confirms every attribute as shown; `confirm_with_edit` changes
attributes explicitly.

## 4. Resolution: observations → items → assertions

### 4.1 Keyed items

Keyed claim types derive `itemKey` deterministically (§3.2). Items are upserted on the unique
`(subjectId, itemKey)` index, so concurrent creation converges on one item.

### 4.2 Matched items (roles, projects)

Roles have no natural key. The matcher (`resolution/role-matcher.ts`, pure) compares a role
observation with the subject's active role items:

| Situation                                                                                      | Outcome                                     |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------- |
| same organization key and compatible start, same or compatible title                           | same item                                   |
| same organization key, periods overlap ≥ 50 % of the shorter, titles differ only by seniority  | same item (title reconciles separately)     |
| same organization key, different titles, consecutive or barely overlapping periods             | different items (promotion)                 |
| same organization key and title, periods separated by > 3 months                               | different items (return to employer)        |
| organization names fuzzy-similar (Jaro-Winkler ≥ 0.92) or item marked `distinctFrom` undecided | new item + `same_item` confirmation request |
| items recorded `distinctFrom` each other (subject said "keep separate")                        | never matched again                         |
| otherwise                                                                                      | new item                                    |

Matched-item creation is **subject-fenced**: the resolver reads `profile.resolutionRev = R`, the
subject's pending observations and active items; computes assignments; and commits in one
transaction: CAS `resolutionRev R → R+1`, insert new items (id anchored on the creating
observation), upsert assertions (`$setOnInsert`, state `PROPOSED`), and set each observation's
`resolution` (guarded on `resolution.state = pending`). A lost CAS re-reads and recomputes. Per
subject volumes are small (tens to hundreds of observations), so serializing resolution per
subject is cheap and removes duplicate-item races.

### 4.3 Assertions

`assertionId = det(itemId, valueKey)`: identical normalized values from any number of sources share
one assertion. Upserts never modify an existing assertion's state — a `REJECTED` assertion stays
rejected when its evidence is re-extracted (R-14); if the new support comes from a
subject-authored source with a later `sourceAsOf` than the rejection, a `confirm_new` request with
reason `rejected_restated` is opened.

## 5. Assertion lifecycle

```text
                 ┌──────────── automation ─────────────┐
                 ▼                                      │
   (upsert) ─► PROPOSED ◄──────────► CONFLICTED         │
                 │  │  \                │  │            │
       subject:  │  │   \ automation:   │  │ automation │
       confirm   │  │    └► SUPERSEDED ◄┘  │            │
                 │  │    └► WITHDRAWN ─────┴────────────┘ (support returns → PROPOSED; item merged → SUPERSEDED)
                 ▼  ▼ subject: reject
            CONFIRMED ──subject: revoke──► REJECTED ──subject: confirm──► CONFIRMED
                 │
                 └──subject: confirm newer value / mark_outdated / confirm_with_edit──► SUPERSEDED
   SUPERSEDED ──automation: revival (newer current_state support, or chronology winner lost its support, §6)──► PROPOSED
   SUPERSEDED ──subject: confirm (restore an older value)──► CONFIRMED
   SUPERSEDED ──subject: reject (that old value was wrong)──► REJECTED
```

| From → To                                 | Who        | Trigger                                                                                                                                                |
| ----------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| — → PROPOSED                              | automation | first supporting observation                                                                                                                           |
| PROPOSED ↔ CONFLICTED                     | automation | reconciliation finds / no longer finds an incompatible rival or confirmed value                                                                        |
| PROPOSED/CONFLICTED → SUPERSEDED          | automation | a newer `current_state` value of equal or higher basis wins; or the item was merged                                                                    |
| PROPOSED/CONFLICTED → WITHDRAWN           | automation | no current support left (observations superseded by a newer extractor, quarantined, source disowned)                                                   |
| WITHDRAWN → PROPOSED                      | automation | support returns (e.g. quarantine lifted)                                                                                                               |
| WITHDRAWN → SUPERSEDED                    | automation | the item was merged                                                                                                                                    |
| SUPERSEDED → PROPOSED                     | automation | revival: newer `current_state` support, or the chronology winner has no current support any more, under the conditions of §6 (`assertions/revival.ts`) |
| PROPOSED/CONFLICTED/WITHDRAWN → CONFIRMED | subject    | `confirm`                                                                                                                                              |
| PROPOSED/CONFLICTED → REJECTED            | subject    | `reject`                                                                                                                                               |
| PROPOSED/CONFLICTED → SUPERSEDED          | subject    | `confirm_with_edit` (the edited value becomes a new `CONFIRMED` assertion, origin `confirmation_edit`)                                                 |
| CONFIRMED → SUPERSEDED                    | subject    | a different value for the same item is confirmed; or `mark_outdated` (`validTo` recorded)                                                              |
| CONFIRMED → REJECTED                      | subject    | `revoke` (the confirmation was wrong)                                                                                                                  |
| REJECTED → CONFIRMED                      | subject    | `confirm` (explicit un-reject)                                                                                                                         |
| SUPERSEDED → CONFIRMED                    | subject    | `confirm` of an older value (restores it; the current confirmed value is superseded)                                                                   |
| SUPERSEDED → REJECTED                     | subject    | `reject` of an old value ("that value was wrong"; answers `outdated_restated`)                                                                         |
| — → CONFIRMED                             | subject    | `confirm_with_edit` creates the edited value — **only** when no assertion with that `valueKey` exists                                                  |

Enforcement (PL-3): `assertions/transitions.ts` exports `allowedTransition(from, to, actorClass)`
with `actorClass ∈ { automation, subject }`; every write is a guarded update
`{ _id, state: from } → { state: to }` issued only after that check; automation writes additionally
filter `state ∉ { CONFIRMED, REJECTED }`. A mutation test flips each row of the table and the
suite must fail. Two rows carry conditions the table cannot express: revival (`SUPERSEDED →
PROPOSED`) is allowed only when `canRevive` (§6) says so — its write filter comes only from
`revivalGuard`, never from `transitionGuard` directly — and creation as `CONFIRMED` only when
the item has no assertion for that value (`assertionId = det(itemId, valueKey)`); otherwise the
decision is that assertion's own subject transition (`confirmationTransition`), and confirming a
value that is already `CONFIRMED` is no transition (`reconfirmedAt` is recorded). A **challenged** confirmed assertion keeps `CONFIRMED`; the challenge lives in the
item's `conflicts[]` and in an open `reconfirm` request.

## 6. Reconciliation

`reconcileItem({ item, assertions, openRequests, organizationAliases }, policy) → { canonical,
changed, derivedChanged, transitions[], supersessionUpdates[], requests{open, keep, close},
events[] }` (`reconciliation/policy.ts`) is pure and versioned (`POLICY_VERSION = prof-rec-1`; the
policy value `PROF_REC_1` bundles the precedence ladder, the compatibility rules and the revival
guard). Inputs are plain values: the item (claim type, active, stored canonical), its assertions
with a **support summary** (current supporting observations: count, modes, source ids, newest
`observation.sourceAsOf`, newest declared-date and subject-authored `sourceAsOf`, unverified spans,
withdrawn support), confirmation and reaffirmation times, and the stored supersession of
`SUPERSEDED` assertions. Purity is enforced by `reconciliation/purity.test.ts` (no I/O imports,
transitively; no clock, randomness, crypto or network). Results never depend on assertion ids:
ties break by precision, then chronology, then the normalized value (property-tested).

```text
1. support and revival (before the active set is computed):
     PROPOSED/CONFLICTED without current support → WITHDRAWN (no_current_support)
     WITHDRAWN with support                      → PROPOSED  (support_returned)
     SUPERSEDED with support: the stored supersession is re-evaluated (supersessionHolds):
        newer_state      holds while the superseder is not REJECTED and still has the chronology it
                         won with (newest support, or confirmation/reaffirmation when CONFIRMED)
        confirmed_rival  holds while the confirmed rival is CONFIRMED with that chronology, or was
                         marked outdated by the subject; not once it is revoked (REJECTED)
        subject_decision holds while the value it agrees with is still rejected / marked outdated
        subject, merge   always hold (subject: a confirmed winner that lost its evidence asks
                         reconfirm/superseder_withdrawn instead)
     revivalGuard(...) → PROPOSED (revived; the event keeps the prior supersession), iterated to a
     fixed point within the run (a revival can invalidate another value's supersession)
2. basis per assertion (confirmed iff CONFIRMED, else best support mode by the ladder)
   Ruling 2 (no confirmed value): an unconfirmed value compatible with a value the subject marked
   outdated, or compatible with and at least as precise as a value the subject rejected (rejecting
   "Python: expert" leaves plain "Python"; rejecting London, GB leaves GB), is held — current_state:
   SUPERSEDED (subject_decision), escaped only by declared support newer than the decision;
   historical / set_member: CONFLICTED (conflict contradicts_decision), never escaped by dates
   (a restatement request asks when subject-authored support is newer than the decision)
   active = {PROPOSED, CONFLICTED, CONFIRMED} \ held; winner tier = highest basis present
3a. winner tier is `confirmed` → C = the (latest) CONFIRMED assertion:
    canonical = C.value, basis = confirmed, status = known
    for A in active \ {C}:
        compatible(A, C), A more precise → A PROPOSED; canonical.refinements += A (suggestion only)
        compatible(A, C)                 → A PROPOSED (corroborates)
        current_state and A not newer than C's chronology (confirmedAt, reaffirmedAt, newest support)
                                         → A SUPERSEDED (confirmed_rival; history, not a challenge)
        otherwise                        → A CONFLICTED; conflict challenges_confirmed; request reconfirm
3b. current_state, pairwise within the winner tier, newest first: a value incompatible with a newer
    kept value → SUPERSEDED (newer_state, by that value); same-date incompatible values →
    same_basis conflict; only pairwise-compatible kept values merge. Lower tiers: compatible with
    every kept value → PROPOSED (refinement if more precise); incompatible and not newer than the
    newest such rival → SUPERSEDED (newer_state); newer → CONFLICTED (lower_basis_newer)
3c. historical and set_member (attributes reconcile as historical): chronology never decides;
    incompatible values within the winner tier → all involved CONFLICTED (same_basis); the
    conflicting attributes are `conflicting`, the others stay known; incompatible lower-tier
    values → CONFLICTED (lower_basis); compatible values of the winner tier merge to the most
    precise value; more precise lower-tier values are refinements (suggestions only)
    (3b and 3c) disagreement only on immaterial attributes keeps the item `known`, value from the
    representative, the attribute marked `conflicting`
4. requests (§7.1): reconfirm always (PL-2); otherwise only for material claim types and
   material attributes (§7.2): resolve_conflict, else confirm_change (current_state, the stored
   canonical value was superseded by the new winner; kept while it stands), else confirm_new
   (naming the canonical assertion); confirm_new (rejected_restated / outdated_restated) for a
   rejected, subject-superseded or held value whose subject-authored support is newer than the
   decision (every field class); confirm_new (current_unknown) when a material item is unknown
   after the subject marked its value outdated or revoked it; confirm_new (held_by_decision) for
   the held candidate when a material item is unknown because of a hold. Open reconciler-owned requests that are no longer
   derived are closed as `superseded`; same_item and accept_target are never touched.
confidence = f(basis, span verification, distinct sources, conflicts)   (provenance Confidence shape)
```

Confidence reasons are enum-like strings (`confirmed`, `stated`, `extracted`, `inferred`,
`<n> sources agree`, `unverified_span`, `lower basis conflict`, `challenged`, `same basis
conflict`, `no_evidence`), never quotes. Every transition in the result carries its write guard
(`transitionGuard`, or `revivalGuard` for revivals) and consecutive steps of one assertion form a
legal path (`WITHDRAWN → PROPOSED → CONFLICTED`); net no-op paths are dropped, and a path back to
`SUPERSEDED` with a different supersession becomes a `supersessionUpdate`. `changed` compares the
canonical fingerprint (value, status, basis, assertion, refinements, conflicts, attribute status)
with the stored one (a new profile version); `derivedChanged` reports confidence/evidence-count
only changes (item write, no version). The result is a fixed point (reconciling it again changes
nothing).

**Revival (`SUPERSEDED → PROPOSED`).** A `current_state` value can legitimately return (London →
Berlin → London): the newest source supports the same value and therefore the same, superseded
assertion. The reconciler revives it only when all of these hold (`assertions/revival.ts`:
`canRevive`, and `revivalGuard`, the only source of the revival write filter):

- (a) the claim type's field class is `current_state`; `historical` and `set_member` values,
  assertions superseded by an item merge, and assertions of inactive items never revive;
- (b) the new support's `sourceAsOf` is strictly later than the threshold captured **when it was
  superseded** and stored on the assertion as `supersededAtAsOf` — the winner's `sourceAsOf`
  (automation) or the recorded `validTo` (subject supersession) — so replaying or reprocessing
  an older snapshot never revives. Dates are `observation.sourceAsOf` (immutable per
  observation), never a snapshot's `sourceAsOf`, which moves forward on genuine re-acquisition;
- (b\*) exception to (b): a stored **automation** supersession (`newer_state`, `confirmed_rival`)
  or a `subject_decision` hold that no longer holds (step 1 above) makes the value a revival
  candidate regardless of dates (still only to `PROPOSED`, through `revivalGuard`, only for
  `current_state`). A winner confirmed without evidence keeps its confirmation chronology, so only
  a winner that lost the evidence it won with (or was revoked) invalidates the supersession. After
  a **subject** supersession a withdrawn winner never revives anything; a `reconfirm`
  (`superseder_withdrawn`) request is opened instead unless the subject has since kept the winner;
- (b') after a **subject** supersession (`mark_outdated`, a rival confirmed) only a **declared**
  document date counts: an undated document (acquisition-time `sourceAsOf`) never revives; the
  assertion stays `SUPERSEDED` and a `confirm_new` request with reason `outdated_restated` is
  opened when the support is subject-authored (analogous to `rejected_restated`, R-14);
- (c) basis stays `confirmed` iff state is `CONFIRMED`; a revived value under a confirmed rival is
  `CONFLICTED` with a `reconfirm` request and the canonical value does not change;
- (d) revival is a recorded reconciler transition: an `assertion.revived` event that keeps the
  prior supersession (`supersededBy`, cause, `supersededAtAsOf`), and a new profile version.

**Persistence (revision-fenced, B3-R2 pattern).** The reconciler reads the item (`rev = R`) **before**
its assertions, computes, and commits one transaction: CAS item `rev R → R+1` over derived fields
only (`canonical`, `lastChangedAt`), guarded assertion transitions, events, and request upserts. If
the CAS fails it re-reads and recomputes (≤ 10 attempts), never re-submitting the stale result. A
recompute that yields the same canonical value commits nothing (no revision bump, no event).

**Profile projection.** After items change, `ProfileService.refresh(subjectId)` reads
`profile.rev`, builds the projection (sections → items → canonical summaries, plus derived views
such as total experience with their derivation), and if its content hash differs from the
current version it commits in one transaction: CAS `profile.rev`, insert
`professional_profile_versions` `{ version: n+1, contentHash, diff, cause }`. Equal hash → no
version (A → B → A creates three versions; replays create none).

## 7. Confirmation

### 7.1 Requests

| Type               | Opened when                                                                          | Answer actions                                         |
| ------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `confirm_new`      | a material item has no confirmed value; or `rejected_restated` / `outdated_restated` | confirm, confirm_with_edit, reject, defer              |
| `resolve_conflict` | same-tier historical conflict, or material lower-basis conflict                      | confirm (one of), confirm_with_edit, reject, defer     |
| `reconfirm`        | evidence challenges a confirmed value                                                | confirm (keep or switch), mark_outdated, revoke, defer |
| `confirm_change`   | a newer unconfirmed current-state value replaced an older one                        | confirm, reject, defer                                 |
| `same_item`        | resolution ambiguity between two items                                               | merge_items, keep_separate, defer                      |
| `accept_target`    | a career target was proposed from evidence                                           | accept, decline, defer (targets module)                |

`dedupeKey = type : reason : itemIds : sorted assertionIds` (`reconciliation/requests.ts`); a
unique partial index keeps one open request per question. A request whose question disappears
(e.g. the rival assertion was withdrawn) is closed as `superseded` by the reconciler. Requests
carry enum-coded parameters and ids, never free text copied from documents: `params.reason`,
`params.attributes` (conflicting attribute names) and `params.roles` (each named assertion's role:
`confirmed`, `challenger`, `from`, `to`, `candidate`, `rival`, `rejected`, `outdated`).
`priority = materiality(claimType) × kind weight` (material 3, other 1; reconfirm 4,
resolve_conflict 3, confirm_change 2, same_item 2, confirm_new 1, accept_target 1). The
reconciler derives one request per question from state, so a recompute re-derives the same keys:
`confirm_change` is opened when the stored canonical value was superseded by a newer winner and
kept while that winner is unconfirmed and the old value stays superseded.

**Answerability.** Every reason has legal answers that remove its condition, so an answered
question never comes back unless new evidence arrives. Reaffirmations are recorded as timestamps
the policy compares evidence against (`reaffirmedAt` on a CONFIRMED value, `rejectionReaffirmedAt`
on a REJECTED one; "still outdated" moves the stored `supersededAtAsOf`/`validTo`):

| Type / reason                                                      | Condition                                                                                                             | Legal answers (each removes the condition)                                                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `confirm_new` / `unconfirmed_material`                             | material item known, nothing confirmed; names the canonical assertion                                                 | confirm, confirm_with_edit, reject                                                                                  |
| `confirm_new` / `rejected_restated`                                | subject-authored support newer than the rejection (or the latest "still rejected")                                    | confirm (`REJECTED → CONFIRMED`), still rejected (`rejectionReaffirmedAt`)                                          |
| `confirm_new` / `outdated_restated`                                | subject-authored support newer than `validTo` of a subject-superseded value                                           | confirm (restore, `SUPERSEDED → CONFIRMED`), reject (`SUPERSEDED → REJECTED`), still outdated (moves `validTo`)     |
| `confirm_new` / `current_unknown`                                  | material item unknown after the subject marked its value outdated or revoked it                                       | confirm_with_edit (the current value), confirm an older value (restore); `defer` is the "don't know" answer         |
| `confirm_new` / `held_by_decision`                                 | material item unknown because a supported value is held by a subject decision (Ruling 2)                              | confirm the held value, reject it                                                                                   |
| `resolve_conflict` / `same_basis_conflict`, `lower_basis_conflict` | material conflict, nothing confirmed                                                                                  | confirm one (incompatible rivals rejected), confirm_with_edit, reject                                               |
| `reconfirm` / `challenges_confirmed`                               | evidence newer than the confirmed value's chronology (confirmation, newest support, `reaffirmedAt`) disagrees with it | keep (`reaffirmedAt`, optionally rejecting the challengers), switch (confirm the challenger), mark_outdated, revoke |
| `reconfirm` / `multiple_confirmed`                                 | two confirmed values disagree                                                                                         | confirm one (the other is superseded)                                                                               |
| `reconfirm` / `superseder_withdrawn`                               | the value the subject preferred lost all its evidence; the old one still has some                                     | keep (`reaffirmedAt`), switch (confirm the old value), revoke, reject the old value                                 |
| `confirm_change` / `newer_state`                                   | a newer unconfirmed current-state value replaced an older one                                                         | confirm the new value; reject it (the older value revives, Ruling 1c); confirm the older value                      |

`defer` is always available and changes nothing (the request stays open, snoozed); for
`current_unknown` it is the "don't know" answer. A `contradicts_decision` conflict is presented as
"held by subject decision" (the value agrees with something the subject rejected or marked
outdated), not as a disagreement between sources.

### 7.2 Materiality (v1)

Material: `experience.role` (organization, title, dates), `education`, `certification`,
`work_authorization`, `location.current`, `identity.name`. Non-material: `skill`,
`language` proficiency, `positioning.headline`, preferences. Non-material conflicts are visible on
the item but do not open requests until the subject reviews the area. Within a material composite,
only conflicts on material attributes open requests (roles: organization, title, start, end — not
employment type or workplace; certifications: not the URL; education: not the field). Materiality
gates every reconciler request **except** `reconfirm` (a challenge to a confirmed value always asks,
PL-2) and the `rejected_restated` / `outdated_restated` questions (the subject restated a value).

### 7.3 Decision operation (single transaction)

```text
POST /api/professional/items/:itemId/decisions   (Idempotency-Key required)
  { expectedItemRev, requestId?, action, assertionId?, value?, validTo?,
    otherItemId?, expectedOtherItemRev?, reason?, attestation: { mode: 'operator_relayed', statementRef?, statedAt? } }

1. validate (nothing persisted on failure → 400 validation_failed | illegal_transition):
   shape; action allowed for the request type; assertion belongs to the item; transition legal
   for actor class `subject` from the assertion's current state; value valid for the claim type;
   merge target active and in the same subject/area.
2. op = det(subjectId, Idempotency-Key): exists → same decisionHash ? return stored result
   : 409 idempotency_key_reused.
3. ONE transaction:
     insert operation { state: applied }                      (duplicate key → step 2)
     CAS item { rev: expectedItemRev, status: active } → rev+1 (miss → abort → 409 stale_item_revision)
     (merge_items / keep_separate: also CAS the other item on expectedOtherItemRev)
     guarded assertion transitions { _id, state: from }       (miss → abort → 409 concurrent_state_change)
     insert edited assertion (confirm_with_edit), items' distinctFrom/merge effects
     recompute the item's canonical from the in-transaction assertion set (pure reconcileItem)
     close the request { status: open } → resolved           (miss → abort → 409 request_already_resolved)
     events (deterministic ids)
4. outbox (recorded on the operation, each step idempotent):
     derived: ProfileService.refresh (revision-fenced) → profile version
     resume:  resumeByCorrelationKey(requestId) (only WAITING nodes resume)
   → state completed. The hourly `professional.maintenance` workflow finishes operations left `applied`.
```

Decision semantics that are not obvious from the transition table:

- Confirming one assertion of a `resolve_conflict` or `reconfirm` request rejects the
  **incompatible** rivals named in the request (reason `rejected_in_favour_of`); compatible ones stay
  `PROPOSED`. Keeping an already confirmed value records `reconfirmedAt` on it (no transition).
- `confirm` of a different value than the current confirmed one supersedes the old confirmed
  assertion (`validTo` = the decision's `statedAt`, else now).
- `defer` changes no assertion and no item revision: the request stays open with `snoozedUntil`
  (hidden from the default queue) and the operation records the deferral.

**Why no claim/lease/generation (contrast ADR-0017).** Market review decisions write several
services, launch source runs and needed a durable claim to fence effects across steps. A
Professional decision has no external effect and all canonical effects commit in one transaction
guarded by the item revision the decider saw, so the revision **is** the fence: a stale or
concurrent decision commits nothing. Post-commit steps are recomputation (the same fenced code
automation runs) and workflow resume (idempotent), so replaying them is always safe. If a future
decision gains an external effect, it must adopt the ADR-0017 intent/outbox pattern.

`expectedItemRev` makes the decider state which evidence they saw: if new contradicting evidence
arrived while the operator was relaying the question, the decision is refused and the UI reloads —
the subject never confirms a view that is no longer current.

**Attestation.** v0.1 has one mode, `operator_relayed`: an internal operator records what the
subject confirmed (`statementRef` = operator's reference to the conversation or message, no
content). It counts as a subject confirmation for precedence. Operators cannot confirm on their
own authority; their data-quality actions (quarantine an observation, retry an extraction) are
separate endpoints that only change evidence, never confirmation state.

## 8. History and versioning

| What                | How it is kept                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Evidence            | observations append-only; `status` current/superseded/quarantined; never deleted                  |
| Claim states        | assertions never deleted; `stateReason`, `stateChangedAt`, `supersededBy`, `validTo`; events      |
| Confirmations       | operations retained indefinitely (they are replay fences and history)                             |
| Canonical profile   | immutable `professional_profile_versions` (full projection + diff + cause), monotonic per subject |
| Previous role state | role items keep all assertions; versions show e.g. end `present(asOf 2022-01)` → `2023-06`        |
| Career targets      | immutable `professional_career_target_versions` per edit                                          |
| Operator actions    | events with actor and reason code                                                                 |

Retention: all of the above are retained indefinitely in v0.1 (replay horizon unbounded, as in
Market). Legal erasure is the only deletion path and is not implemented in v0.1 (§13).

## 9. Career targets

`professional_career_targets` holds the current state; each change writes a new immutable
`professional_career_target_versions` document in the same transaction (CAS on `rev`).
Implemented in P5.1 (`targets/`); Admin contract
[`professional-career-targets`](../programme/contracts/professional-career-targets.md).

```text
TargetSpec {
  label                               // operator/subject-given short name
  fit: {                              // capability-relevant: what kind of work
    roleFamilies: RoleFamily[] (≥ 1); specializations?; titles?
    seniority: { min?, max? }
    skillsFocus?: [{ label, concept | null }]
    industries?; domains?; excludedIndustries?; companyStages?; employmentTypes?
  }
  viability: {                        // SENSITIVE (include=sensitive): where and on which terms
    geography: [{ scope: country|region|city|anywhere, code?, city?, mode: live_in|commute_to|remote_from }]
    workModels?: { acceptable, preferred? }; remoteScope?: { timezoneWindow? }
    compensation?: { currency, min?, target?, period, basis, negotiable? }
    constraints: [{ kind: start_date|max_travel|contract_length|other, value, strength: hard|soft }]
  }
  rationale?                          // SENSITIVE (free text)
}
CareerTarget { subjectId, status: proposed|active|paused|archived|declined, priority? (ranked only),
               spec, origin: stated|proposal|accepted_proposal, basis: confirmed|inferred,
               proposalEvidence?: observationIds[], rev, version }
```

- **Fit ≠ viability** (INTEGRATION_CONTRACTS §4): the `fit` part is what a future fit computation
  may read (`CareerTargetsV1` carries `label` + `fit` only); geography (location, relocation,
  commuting, remote-from), work models, timezone window, compensation, constraints and the
  free-text rationale are the `viability` part (`CareerTargetViabilityV1`), excluded from every
  response unless `include=sensitive`, and writing them needs it too (R-30).
- Several targets may be `active` at once. Ranked targets (`active`, `paused`) carry a unique
  `priority` (1 = highest; gaps allowed after archive; a newly ranked target goes last);
  `POST …/targets/reorder` lists every ranked target with its `rev` and writes every changed
  target's version in one transaction. Every target transaction first increments the subject's
  `targetsRev` under `status: active` — concurrent ranking changes of one subject serialize
  (unique priorities) and archived subjects accept no target changes.
- **Lifecycle** (`targets/transitions.ts`, table-tested): subject — create (`active`|`paused`),
  `proposed → active` (accept) | `declined` (decline, terminal), `paused|archived → active`,
  `active → paused`, `active|paused → archived`; automation — create as `proposed` only.
  **The subject outranks inference**: stated and accepted targets are `basis: confirmed`,
  proposals `inferred`; automation may edit only its own proposal while it is `proposed` and can
  never change a confirmed target. Automation never overwrites the subject's input: a subject
  edit of a proposal keeps it `proposed` but marks it `subjectEdited` (automation edits refused
  afterwards), and automation may edit only proposals it created. v0.1: the internal operator
  relays the subject (`attestation.mode: operator_relayed` on each version).
- At most 100 open targets (proposed, active, paused) per subject — checked on creation and on
  re-opening (activate from archived), inside the subject fence; archived and declined ones are
  history, listed with keyset pagination. Versions are listed with keyset pagination; `fitHash`
  (sha-256 over `label` + `fit`) is the drift pin a consumer stores with `(targetId, version)`.
- Proposals (P5.2) come from `preference.career` observations and questionnaire answers through a
  deterministic mapping; AI may propose a spec only as `proposed` with evidence, and an
  `accept_target` request is opened.
- **Eligibility is excluded by schema**: no work-authorization, sponsorship-need or visa field
  exists in `TargetSpec`; the server-side validator closes every nested object of the target
  collections, so such a field cannot be added around the application either. Where a target's
  geography requires authorization, Opportunity later reads the eligibility section;
  Professional does not precompute viability.

## 10. Idempotency and replay

| Write                          | Strategy                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Subject, source, target create | `Idempotency-Key` → deterministic id; duplicate insert returns the existing document                                                     |
| Snapshot                       | `ArtifactStore` content addressing + unique `(sourceId, contentHash)`; re-acquisition bumps counters by distinct run                     |
| Extraction                     | deterministic `pext` per `(snapshot, extractor@version)`; `completed` extraction is a replay marker                                      |
| AI call                        | `professional_ai_extractions` keyed by content hash: completed → reused (no call); `calls > 1` counted (`ai_calls_repeated_total{task}`) |
| Observations                   | deterministic ids, insert-if-absent; supersession by extractor version is set-based and idempotent                                       |
| Resolution                     | subject-fenced (`resolutionRev` CAS) + unique item keys + deterministic assertion ids + guarded `resolution.state`                       |
| Reconciliation                 | recompute-from-evidence with item/profile `rev` CAS; equal result commits nothing                                                        |
| Profile version                | written only in the CAS transaction that moves `profile.rev`; equal content hash → none                                                  |
| Confirmation decision          | deterministic operation id; single transaction guarded by item rev and assertion states; outbox steps idempotent                         |
| Requests / review items        | unique partial `(subjectId, dedupeKey)` on open                                                                                          |
| Events                         | deterministic ids with `$setOnInsert`                                                                                                    |

**Chronology (ADR-0019).** `sourceAsOf` is the declared document date if the subject/operator
provided one, else the acquisition time of the snapshot, and only moves forward on genuine
re-acquisition. Reprocessing an old snapshot reuses its `sourceAsOf`, so an old CV processed after
a newer one can never win a `current_state` field. Snapshots record which it is:
`sourceAsOfKind: declared | acquired`, and a declared date is authoritative (supervisor ruling,
P1.2). An undated upload of bytes the source already has is a re-acquisition: it counts
(`acquisitions`, `lastAcquiredAt`) and moves an `acquired` `sourceAsOf` forward (so A → B → A
makes A current again); a `declared` `sourceAsOf` does not move. The first declared date on an
`acquired` snapshot converts it to `declared` with `sourceAsOf = declaredAsOf`, even when that is
earlier — a correction of provenance, not its destruction: the replaced value stays in
`previousSourceAsOf` and a `snapshot.dated` event records `acquired → declared`. A different
declared date on a `declared` snapshot is 409 `conflict` (`declared_date_mismatch`); an operator
date-correction action is P3.2 planning, which also states how `declared` and `acquired` dates
compare in `current_state` precedence. Each observation stores the `sourceAsOf` it
was extracted with (immutable) and whether that date was declared (`sourceAsOfKind`); the
reconciler's support summary uses these, never the snapshot's current `sourceAsOf`.

## 11. Capabilities

Inputs and outputs are **ids and counts only** (R-34), enforced mechanically:
`privacy/capability-io.ts` walks every `professional.*` capability's input, output and config
schema and a unit test fails on any string that is not an id, code or hash pattern, or any
unchecked (`any`/`unknown`/transform) value. Every side-effecting capability is `key` or
`natural` (ADR-0015) and appears in the generated capability matrix.

| Capability                          | Queue     | Strategy | Idempotency proof (summary)                                                   |
| ----------------------------------- | --------- | -------- | ----------------------------------------------------------------------------- |
| `professional.load_snapshot@1`      | `default` | pure     | reads snapshot/source; validates limits and consent                           |
| `professional.fetch_source@1`       | `io`      | natural  | content-addressed artifact + unique `(sourceId, contentHash)` snapshot        |
| `professional.extract_text@1`       | `default` | natural  | text artifact content-addressed; extraction record deterministic              |
| `professional.extract_structured@1` | `default` | natural  | deterministic observation ids; completed extraction is a replay marker        |
| `professional.extract_semantic@1`   | `ai`      | natural  | content-hash AI ledger reuses results; deterministic observation ids          |
| `professional.resolve_subject@1`    | `default` | natural  | subject `resolutionRev` CAS; unique item keys; guarded observation resolution |
| `professional.reconcile_subject@1`  | `default` | natural  | recompute from evidence; item/profile revision CAS                            |
| `professional.await_confirmation@1` | `default` | natural  | suspends on request id; resume is idempotent (only `WAITING` nodes)           |
| `professional.propose_targets@1`    | `default` | natural  | deterministic proposal ids from evidence ids                                  |
| `professional.maintenance_sweep@1`  | `default` | natural  | completes `applied` operations' outbox; closes superseded requests            |

Workflows (code-authored, versioned on registration):

| Workflow                         | Nodes                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `professional.source.ingest`     | trigger → load_snapshot → extract_text → extract_structured → extract_semantic → resolve_subject → reconcile_subject |
| `professional.source.fetch`      | trigger → fetch_source → `core.execute_subworkflow(professional.source.ingest)`                                      |
| `professional.subject.reconcile` | trigger → resolve_subject → reconcile_subject                                                                        |
| `professional.maintenance`       | schedule (hourly) → maintenance_sweep                                                                                |

Input `{ subjectId, sourceId?, snapshotId? }`; labels `{ subjectId, sourceId }` (opaque ids; the
platform adds a `labels.subjectId` run index). `extract_semantic` skips (not fails) with reason
`ai_not_permitted` or `ai_unavailable` and records it on the extraction.

### 11.1 AI tasks

| Task / prompt id                       | Input                             | Output (Zod)                                                                       |
| -------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| `professional.cv_section_extract@1`    | one masked CV section             | claims `[{ claimType, fields (strings as written), quote }]`, no normalized values |
| `professional.document_extract@1`      | masked portfolio/case-study text  | projects, achievements, portfolio evidence with quotes                             |
| `professional.career_intent_extract@1` | masked objective/career statement | target proposal fields with quotes                                                 |

The model returns text as written plus quotes; deterministic code then (1) verifies each quote
is a whitespace-normalized substring of the section, (2) parses values from the quote (dates,
countries, languages, skills via taxonomy), (3) applies the protected-data filter. A value whose
quote fails verification becomes `inferred`/low with warning `unverified_span`, or is dropped for
material claim types. Text is split by section and each section's hash keys the cache, so an
updated CV only pays for changed sections.

## 12. API surface (`/api/professional/*`)

All lists: `limit` (≤ 100) + cursor, `sort`, documented filters. All mutations: Zod body,
`Actor` from `resolveActor`, `Idempotency-Key` where creation or a decision is involved.
`include=sensitive` is required to return `eligibility`, compensation and target compensation
(and a remote preference's `timezoneWindow`).

| Method & path                                                                                                  | Purpose                                                                                                    |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST /subjects` · `GET /subjects` · `GET /subjects/:id`                                                       | create (with consent) / list / overview (counts, profile version, open requests)                           |
| `PATCH /subjects/:id` · `POST /subjects/:id/archive`                                                           | reference/consent changes (event-recorded) / archive                                                       |
| `POST /subjects/:id/sources` · `GET /subjects/:id/sources`                                                     | register / list sources                                                                                    |
| `GET /sources/:id`                                                                                             | source, snapshots, extractions, health                                                                     |
| `POST /sources/:id/uploads`                                                                                    | upload bytes → snapshot (P1.2: 201/200); P1.3 adds the ingest run id                                       |
| `POST /sources/:id/fetch`                                                                                      | fetch stated URL/handle (not for `linkedin_export`) → run                                                  |
| `POST /subjects/:id/statements`                                                                                | manual input / questionnaire answers → form snapshot → ingest                                              |
| `POST /snapshots/:id/reprocess`                                                                                | re-run ingest on a stored snapshot                                                                         |
| `GET /snapshots/:id/content`                                                                                   | private artifact content, only with `include=sensitive` (subject-checked, `text/plain`, nosniff, CSP none) |
| `GET /subjects/:id/observations` · `GET /observations/:id`                                                     | evidence (filter by source, claim type, status)                                                            |
| `POST /observations/:id/quarantine` · `/unquarantine`                                                          | operator data-quality action (reason code)                                                                 |
| `GET /subjects/:id/items` · `GET /items/:id`                                                                   | canonical items with assertions, evidence, conflicts, requests, events                                     |
| `GET /assertions/:id`                                                                                          | assertion with support and transition history                                                              |
| `POST /items/:id/decisions` · `GET /confirmation-operations/:id`                                               | decision (§7.3) / operation result                                                                         |
| `GET /confirmation-requests` · `GET /confirmation-requests/:id`                                                | queue (filter: subject, type, status, priority, age)                                                       |
| `GET /subjects/:id/profile`                                                                                    | current projection (`sections=`, `include=sensitive`)                                                      |
| `GET /subjects/:id/profile/versions` · `/versions/:n` · `/diff?from&to`                                        | history and diffs                                                                                          |
| `POST /subjects/:id/targets` · `GET /subjects/:id/targets`                                                     | create / list                                                                                              |
| `GET /targets/:id` · `PATCH /targets/:id` (`expectedRev`) · `GET /targets/:id/versions(/:n)` · `/diff?from&to` | detail / edit → new version / history and diffs (`include=sensitive` for viability)                        |
| `POST /targets/:id/{activate,pause,archive,accept,decline}` · `POST /subjects/:id/targets/reorder`             | status and priority                                                                                        |
| `GET /review` · `POST /review/:id/resolve`                                                                     | operator data-quality queue (retry, quarantine, dismiss)                                                   |
| `GET /metrics/data-quality`                                                                                    | assertion states, conflicts, backlog age, span verification, AI cost/cache                                 |

Errors: `400 validation_failed | bad_request | illegal_transition | consent_required |
linkedin_import_only`, `404 not_found`, `409 stale_item_revision | concurrent_state_change |
idempotency_key_reused | request_already_resolved | stale_target_revision | subject_archived |
stale_subject_revision`, `413 upload_too_large`, `415 unsupported_media_type`, `500 internal`
(with `requestId`). Error bodies are `{ error: { code, message, details?, issues? } }`: messages
are fixed texts, `issues` carry path/code/message only, and nothing echoes request values. The
Professional route module has its own error handler; unexpected failures are logged as
`safeError` (class and codes; never message, `errInfo` or `keyValue`).

**Implemented in P1.1** (contracts `professional-subject-list`, `professional-subject-detail`):
`POST/GET /subjects`, `GET/PATCH /subjects/:id` (overview: subject, counts by area, latest events;
PATCH with optional `expectedRev`), `POST /subjects/:id/archive`, `POST/GET
/subjects/:id/sources`, `GET /sources/:id`. Lists use `limit` (≤ 100) + opaque cursor over
`(createdAt, _id)`. Subject creation and source registration take an optional `Idempotency-Key`
(`det(psub, 'idem', key)`, `det(psrc, subjectId, 'idem', key)`; the hash of the normalized
request is stored so a reused key with another body is 409). A source key whose request matched
an existing source by natural key is bound to it (`idempotencyBindings`, last 20), and key
replays are resolved before the archive check, so a replay after an archive returns the original
source. Keys are scoped per subject, not per actor: v0.1 has one internal operator (ADR-0008);
per-actor scoping is an auth-seam follow-up (L2). Source registration applies the per-kind policy
(`sources/policies.ts`: authorship, allowed acquisition, URL/handle reference, host scope,
ownership `claimed` for fetched URLs/handles) and runs in a transaction that increments the
subject's `sourceCount` under `status: active` — so a concurrent archive and registration
serialize (write conflict) and no source is ever registered after the archive.

**Implemented in P1.2** (contract `professional-subject-detail` v1.1):
`POST /sources/:id/uploads` (raw body, `Content-Type`, optional `declaredAsOf`, optional
`Idempotency-Key`; 201/200 `{ snapshot, created }`), `GET /sources/:id/snapshots` (cursor list),
`GET /snapshots/:id/content?include=sensitive`. Limits and media type are checked before
storage; bytes are put directly through `ArtifactStore` with `PROFESSIONAL_ARTIFACT_LABELS`; the
snapshot (random `psnap` id; identical bytes of a source are found through the unique
`(sourceId, contentHash)` index) is written in a transaction that also fences the subject
(`acquisitionCount` under `status: active`), inserts the `professional_acquisitions` ledger row
(the Idempotency-Key binding: `bindingHash = sha256(contentHash, mimeType, declaredAsOf)`; same →
replay, other → 409 `conflict`; no eviction) and appends `snapshot.created` /
`snapshot.reacquired` / `snapshot.dated`. Every Professional API error is listed in the contract;
upload transport errors (Fastify 413/415) map to `upload_too_large` / `unsupported_media_type` in
the upload route only.

**Implemented in P1.3** (contract `professional-source-detail` v1): capabilities
`professional.load_snapshot@1` (pure: snapshot ↔ source ↔ subject, subject active, data class in
an explicit processable allowlist) and `professional.extract_structured@1` (natural: the
structured extractor), both wrapping failures into fixed codes (no Zod/S3/MongoDB message reaches
node runs or logs); workflow `professional.source.ingest` (trigger → load → extract_structured;
strict id-pattern input, labels ids only; the generic `POST /api/workflows/:key/runs` refuses
`professional.*` keys, and the generic mutations `POST /api/runs/:id/cancel` and
`POST /api/node-runs/:id/{retry,resume}` refuse `professional.*` runs with the same 404 as an
unknown id — `Platform.workflowAccess`; for `resume` an unknown id is now 404 too, was 409;
generic reads are FE-P7's). `POST /subjects/:id/statements` (manual input / questionnaire v1 →
`form` snapshot → ingest; manual statements get the extractor's derived taxonomy/keys, a
disagreeing supplied value is 400), `POST /snapshots/:id/reprocess` (202), `GET /snapshots/:id`,
`GET /subjects/:id/observations`, `GET /observations/:id`. Responses carry the snapshot's
**latest** ingest `runId` (state, not history; `ingest.runId` only moves to a newer run). Each
snapshot's `processing` (`pending | launched | processed | skipped | failed`) is derived from the
extraction ledger plus the run's state through a narrow `RunStateReader` port — never stored,
never read from generic run views; `counts.unprocessedSnapshots` = pending + failed. One initial
run per snapshot. **Run failures vs final failures** (P1.3 re-verify, decided): a run that ended
FAILED/CANCELLED (`run_failed`), whose document is gone (`run_missing`) or that COMPLETED without
recording an extraction (`run_ended_without_extraction`) is `failed` and a re-acquisition starts
one retry run (keyed on that run); a failed extraction is the data's outcome — `failed` with its
code and `final: true`, never retried automatically, and `reprocess` refuses it with 409
`extraction_failed_final` (a new run would replay it; the ledger is per extractor version). On an
extractor version bump, the latest extraction of any version is read: a snapshot extracted by an
older version keeps its outcome with `olderExtractorVersion` (processed/skipped are not
unprocessed and not re-launched; reprocess runs the current extractor; an older failure is not
final). The extraction transaction is fenced on the subject being active (`extractionCount`,
widened; tightening subject counts to required fields later needs an `extractionCount` backfill
migration first, like `acquisitionCount`'s). Carried (L-5/L-6): after a version bump nothing
re-extracts older snapshots by itself — they stay `processed`/`skipped` with
`olderExtractorVersion` until an operator reprocesses them or a P2.1/P3 maintenance run does; a
`final` failure stays counted as unprocessed until it is acknowledged (follow-up: an
"acknowledge final failure" operator action, P3) or a new extractor version reads it. The structured
extractor stores the form as submitted and produces `stated` observations whose evidence is the
form artifact, the field's JSON pointer and the field as stored (`spanVerified` compared, false
when the quote is omitted over 300 chars, N5); other snapshots record `skipped:
unsupported_format`. Sensitive claim types are excluded from evidence responses unless
`include=sensitive` (§13). Metrics `professional_statements_total{outcome, form}`,
`professional_extractions_total{status, extractor}`. No AI in P1.3.

## 13. Privacy implementation

- Logs: ids, enums, counts, error codes. `privacy/logger.ts` wraps the context logger with
  `child({ domain: 'professional' }, { redact })`. Errors thrown by Professional code carry codes
  and ids, never values (the runtime persists `err.message`).
- Request logs (`apps/admin/lib/api-server/request-log.ts`): the API logs request paths without query strings
  (all routes, plus the route template); `/api/professional/*` paths are logged only as their
  route template (or `/api/professional/[unmatched]`), and "route not found" goes through the
  same serializer. Professional routes log through the Professional logger (`onRequest`), and
  their list queries are strict (unknown parameter → 400, name never echoed).
- Sensitive by default (supervisor ruling, P1.3): observations of `sensitive` claim types
  (location, work authorization, relocation, compensation, career preference) — and observations
  carrying a sensitive field (`ClaimTypeDef.sensitiveFields`: `preference.remote.timezoneWindow`,
  which reveals approximate location) — are returned only with `include=sensitive`; without it lists exclude them, a sensitive `claimType` filter is 400,
  and single reads answer like unknown ids. Snapshot bytes (`/snapshots/:id/content`, documents
  and forms alike) are served only with `include=sensitive` (ruling: raw documents can hold any
  sensitive section).
- Metrics: `professional_*` series labelled by `source_kind`, `claim_type`, `extractor`, `outcome`.
- Artifacts: stored through `ArtifactStore` with context labels `{ domain: 'professional' }`
  (`PROFESSIONAL_ARTIFACT_LABELS`; no subject id); ownership is resolved through
  `professional_snapshots.artifact.artifactId` and `professional_extractions.textArtifact`;
  artifacts the runtime writes for a `professional.*` workflow are Professional-owned too. The
  generic `/api/artifacts/:id(/content)` routes refuse such artifacts as if unknown, and
  `GET /api/runs/:id` does not list their refs (none at all for a Professional run) (FE-P6,
  `Platform.artifactAccess` → `ProfessionalDomain.ownsArtifact` / `ownsWorkflow` /
  `referencedArtifactIds`). The runtime copies `*Id` run labels onto the artifacts it writes, so
  Professional documents are stored directly through `ArtifactStore`, never as runtime outputs
  (P1.2: `SnapshotService.upload` puts with `PROFESSIONAL_ARTIFACT_LABELS` only, then references
  the artifact from the snapshot in the same request). Bytes are served only by
  `GET /api/professional/snapshots/:id/content?include=sensitive` (subject-checked,
  `text/plain`/octet-stream, nosniff, CSP `default-src 'none'`, `cache-control: private, no-store`).
- Content hashes are sensitive (supervisor ruling, P1.2 re-verify): a hash of low-entropy content
  is effectively the value. Snapshot ids are random; `contentHash` and the content-addressed
  `artifact` (`artifactId`, `sha256`, `size`) appear in API responses only with
  `include=sensitive` (`api/present.ts`), and the artifact `storageKey` (content-addressed in the
  shared bucket) never. The same holds for an observation's `evidence.artifactId` (P1.3: the
  artifact id is `art_<sha256 prefix>` of the whole form, sensitive answers included): omitted
  without `include=sensitive`. Ledger, event and extraction ids derive from the random snapshot id,
  never from the content hash. Observation ids are different: `det(snapshotId, extractor, claimType,
locator, payloadHash)` is **payload-derived**, so anyone who knows the (visible) snapshot id can
  test a guessed value against it. Rule (supervisor ruling, residuals): **never expose the id of a
  hidden (sensitive) observation on any surface** — lists, single reads, events, review items,
  counts broken down by id, run outputs, logs — without `include=sensitive`; counts of hidden
  observations are allowed metadata. Extractions are presented through the same gate
  (`presentExtraction`: `textArtifact` and section `hash`es only with `include=sensitive`).
- Uploads (R-3): size (streaming body limit, 413), declared media type per kind, byte signature /
  UTF-8 (415) and a PDF page estimate (distinct page objects vs the source's `maxPages`, 413) are
  checked before anything is stored (`sources/upload.ts`); DOCX page counts, compressed PDF
  object streams and archive contents are not inspected before storage — text extraction (P2.1)
  enforces those limits and skips with a code. File names are never accepted or stored.
  `professional_uploads_total{outcome, source_kind}` counts outcomes (enum labels only).
- AI: consent-gated; contact masking (`text/mask.ts`: emails, phone numbers, URLs other than
  stated links, street-address patterns) before rendering prompts; masked spans are excluded from
  quote verification.
- Erasure seam: every Professional document has `subjectId`, and a subject's artifacts are found
  through its snapshots and extractions (`artifact.artifactId`, `textArtifact.artifactId`) — the
  `artifacts` collection itself carries no subject. Deleting them requires FE-P2, which must
  (a) reference-count: content addressing shares one artifact across sources and subjects, so an
  artifact is deletable only when no other snapshot/extraction references it; and (b) sweep
  orphans: an upload that fails after `ArtifactStore.put` (snapshot transaction aborted) leaves
  Professional-labelled bytes that no document references — never served (FE-P6 label check), not
  deletable on failure (another writer may hold the same bytes), so the sweep removes
  Professional-labelled artifacts no snapshot or extraction references. Until then, only synthetic
  and owner-consented data (`consent.dataClass`) may be processed.

## 14. Read models and the Opportunity seam

Exported from `@aptamind/professional/contracts` (Zod, versioned `v1`), each read stamped with
`{ subjectId, profileVersion, policyVersion, taxonomyVersion, generatedAt }` (prefixed ids;
`generatedAt` a `Date` or ISO date-time with offset — nothing is coerced):

| Read model            | Contains                                                                                                                                                                                                                                                        | Never contains                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CapabilityProfileV1` | headline, roles (**without** their workplace `location`, which stays on the item/assertion), skills/tools, education, certifications, languages, projects, achievements, portfolio evidence, industries; each with `basis`, `confidence`, `status`, `confirmed` | location/country/city/region at any depth, work authorization, visa, sponsorship, relocation, compensation |
| `EligibilityV1`       | location, work authorization per jurisdiction (incl. expiry: status `expired` once `validUntil` has passed, value still shown), relocation, mobility                                                                                                            | skills, experience                                                                                         |
| `PreferencesV1`       | remote preference, compensation preferences, career preferences                                                                                                                                                                                                 | eligibility                                                                                                |
| `CareerTargetV1`      | active targets with `(targetId, version)`, priority, taxonomy-coded spec                                                                                                                                                                                        | eligibility                                                                                                |

Read-model entries are projected from the item's `canonical` decision, which also carries
`supportingAssertionIds` (the evidence behind the value) and per-attribute facts
(`attributes[{name, status, value?}]`: a composite value can be `known` with one attribute
`conflicting`, e.g. a role whose employment type disagrees); the profile projection keeps both so
readers can show which attribute is disputed and which assertions support the value.

Every entry is internally consistent (schema-enforced): `confirmed ⇔ basis = confirmed`, and
`value = null ⇔ status ∈ { unknown, conflicting }`; only work-authorization entries may be
`expired`. A role's workplace is a proxy for where the subject can live or work, so the capability
view drops it; the separation test checks every path segment at any depth against the forbidden
set.

A future Opportunity package defines its own reader port; `packages/platform` adapts
`ProfessionalDomain` to it. Opportunity stores the `(subjectId, profileVersion)` and
`(targetId, version)` it scored. Organization names carry a normalized key and optional URL so a
join to Market companies can be made by Opportunity without Professional knowing Market ids.

## 15. Collections

**Schema-change procedure (N4; supervisor ruling, P1.2).** Validators are closed and writers are
upgraded one process at a time, so a schema change is **widen → backfill → tighten**, one release
per step: (1) widen — a new field is optional in the `$jsonSchema` (Zod reader default for missing
values), so documents written by not-yet-upgraded writers still validate and old documents still
read; (2) backfill — an idempotent migration in `packages/platform` `MIGRATIONS` sets the field on
existing documents; (3) tighten — a later release makes it required. First instance:
`professional_subjects.acquisitionCount` (P1.2 widen + backfill migration
`2026-09-30-002-professional-subject-acquisition-count`; tighten carried to P1.3). New
collections and fields no document has yet (P1.2 snapshot fields, `professional_acquisitions`)
need no widening.

**Deploys and validator versions (supervisor ruling, DECISION_LOG bf98d4d).** v0.1 deploys that
change a closed validator are **drain-first**: stop every API/worker process of the old release,
then start the new one — no version overlap. Two mechanisms make that safe even when it is not
followed exactly:

- **Versioned definitions (safety net).** Each Professional collection has a definition version
  (`PROFESSIONAL_COLLECTION_VERSIONS` in `schema-versions.ts`; `collections.test.ts` keeps an
  append-only version → fingerprint history, index key order included, so a spec change without
  a bump fails). `ensureProfessionalCollections` records applied versions in
  `professional_schema_versions` (`$max`, so the record never moves back) and skips — with a
  warning — any collection whose recorded version is newer than the running code's, so a late
  older process (P1.2+) does not re-close a validator or rewrite indexes a newer release applied.
  Read-then-apply is not atomic: two processes of different releases booting at the same moment
  can interleave; drain-first deploys rule that out. Processes of releases before P1.2 are not
  covered (the P1.1 → P1.2 deploy must drain).
- **Migrations widen first.** Migrations run before `ensureReady()`, so a migration that writes
  a new field first applies the (versioned) Professional definitions itself, then writes
  (`2026-09-30-002` widens, then backfills — on a P1.1 database the closed validator would reject
  the `$set` with 121). A migration failure is a failure: only a held migration lock falls back
  to "ensure directly" at boot.

Snapshots v3 (random ids instead of `det(sourceId, contentHash)`) changes the key strategy before
any production data exists: pre-release P1.2 test data may be dropped; no migration is written
(existing test snapshots keep their old ids and still de-duplicate through the unique index).
Snapshots v4 (P1.3) adds the `ingest` launch record (optional; widened).
Subjects v4 (P5.1) adds the optional `targetsRev` ranking fence (widened; read as 0; a fence,
not data, so it is never tightened and needs no backfill); `professional_career_targets` and
`professional_career_target_versions` are new at v1 (no document exists yet, so no widening).

Operator steps: `docs/runbooks/deploy.md`.

All documents carry `schemaVersion`, `createdAt`, `updatedAt` and `subjectId` (except the
subject itself). Validators derive from Zod (ADR-0018).

| Collection                             | Key fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Indexes (name: key — rationale)                                                                                                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `professional_subjects`                | `status`, `reference` (opaque operator token: letters, digits, `_ . : -`; never a name or email), `consent{dataClass, processingBasis, aiProcessing, recordedBy, recordedAt}`, `sourceCount`, `acquisitionCount`, `rev`, `targetsRev?` (career-target ranking fence, P5.1; optional — widen → backfill → tighten), `createRequestHash?`, `createdBy`, `archivedAt?`                                                                                                                                                                                                                                 | `by_status_created: {status, createdAt:-1, _id:-1}`, `by_created: {createdAt:-1, _id:-1}` — subject list (cursor); `by_reference: {reference, createdAt:-1, _id:-1}`                                                                                           |
| `professional_sources`                 | `kind`, `authorship`, `acquisition`, `externalRefKey?`, `url?`, `policy{hostScope, maxPages}`, `ownership{state, assertionId?}`, `status`, `stats`, `health`, `createRequestHash?`, `idempotencyBindings?[{keyId, requestHash}]`                                                                                                                                                                                                                                                                                                                                                                    | `uniq_subject_kind_ref: {subjectId, kind, externalRefKey}` unique partial — idempotent registration; `by_subject: {subjectId, createdAt:-1, _id:-1}` (cursor)                                                                                                  |
| `professional_snapshots`               | `sourceId`, `artifact`, `contentHash`, `mimeType`, `via`, `sourceAsOf`, `sourceAsOfKind`, `declaredAsOf?`, `previousSourceAsOf?`, `acquisitions`, `lastRunId`                                                                                                                                                                                                                                                                                                                                                                                                                                       | `uniq_source_hash: {sourceId, contentHash}` unique — content addressing; `by_subject_asof: {subjectId, sourceAsOf:-1}`; `by_artifact: {artifact.artifactId}` — ownership check, erasure; `by_source_created: {sourceId, createdAt:-1, _id:-1}` — snapshot list |
| `professional_acquisitions`            | `sourceId`, `snapshotId`, `via`, `bindingHash`, `keyed`, `createdBy` (the upload ledger: Idempotency-Key binding, one row per accepted upload)                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `by_snapshot: {snapshotId, createdAt:-1}`; `by_subject: {subjectId, createdAt:-1}` — erasure                                                                                                                                                                   |
| `professional_extractions`             | `snapshotId`, `extractor{name, version (integer), kind}`, `status`, `current`, `textArtifact?`, `sections[{id, class, start, end, hash}]`, `counts{observations, dropped, protectedDropped, unverifiedSpans}`, `skipReason?`, `error{code}`                                                                                                                                                                                                                                                                                                                                                         | `by_snapshot_extractor: {snapshotId, extractor.name, extractor.version:-1}`; `by_subject: {subjectId, createdAt:-1}`; `by_text_artifact: {textArtifact.artifactId}` partial — artifact ownership (FE-P6)                                                       |
| `professional_ai_extractions`          | `task`, `promptId`, `promptVersion`, `schemaVersion`, `model`, `inputHash`, `status`, `calls`, `result{data, meta}`, `useCount`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `by_subject: {subjectId, createdAt:-1}` — erasure, cost per subject                                                                                                                                                                                            |
| `professional_observations`            | `sourceId`, `snapshotId`, `extractionId`, `claimType`, `payload`, `mode`, `extractor`, `evidence{artifactId, locator, quote, spanVerified}`, `confidence`, `warnings`, `sourceAsOf`, `sourceAsOfKind` (`declared`\|`acquired`, copied from the snapshot at extraction; P1.3), `status`, `quarantine?`, `resolution{state, itemId?, assertionId?, resolverVersion}`                                                                                                                                                                                                                                  | `by_subject_resolution: {subjectId, resolution.state, createdAt}`; `by_assertion_status: {resolution.assertionId, status}` — support; `by_snapshot_extractor: {snapshotId, extractor.name, extractor.version}` — supersession                                  |
| `professional_items`                   | `area`, `section`, `claimType`, `itemKey`, `matchKeys`, `distinctFrom[]`, `status`, `mergedInto?`, `canonical{value, status, basis, confidence, assertionId?, supportingAssertionIds[], refinements, conflicts[], attributes[{name, status, value?}], evidenceCount, policyVersion}`, `rev`, `sensitivity`                                                                                                                                                                                                                                                                                          | `uniq_subject_item_key: {subjectId, itemKey}` unique partial `status: active`; `by_subject_area: {subjectId, area, status}`; `by_subject_canonical_status: {subjectId, canonical.status}`                                                                      |
| `professional_assertions`              | `itemId`, `claimType`, `value`, `valueKey`, `state`, `stateReason`, `stateChangedAt`, `basis`, `support{count, sourceIds, sourceKinds, earliestAsOf, latestAsOf}`, `confirmation?{operationId, at, mode}` (`at` required while `CONFIRMED`), `reaffirmedAt?` ("keep"), `rejectionReaffirmedAt?` ("still rejected"), `supersededBy?` (the superseder's or deciding assertion's id), `supersessionCause?` (`newer_state`\|`confirmed_rival`\|`subject`\|`subject_decision`\|`merge`), `supersededAtAsOf?` (revival threshold captured at supersession; `validTo` for `subject`), `validTo?`, `origin` | `by_item_state: {itemId, state}`; `by_subject_state: {subjectId, state, stateChangedAt:-1}`                                                                                                                                                                    |
| `professional_profiles`                | `rev`, `resolutionRev`, `version`, `contentHash`, `projection`, `completeness`, `policyVersion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `uniq_subject: {subjectId}` unique                                                                                                                                                                                                                             |
| `professional_profile_versions`        | `version`, `contentHash`, `projection`, `diff{added, changed, removed}`, `cause{kind, operationId?, runId?}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `uniq_subject_version: {subjectId, version}` unique                                                                                                                                                                                                            |
| `professional_confirmation_requests`   | `type`, `itemIds`, `assertionIds`, `targetId?`, `dedupeKey`, `status`, `priority`, `params`, `itemRevAtOpen`, `snoozedUntil?`, `resolution?`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `uniq_open_dedupe: {subjectId, dedupeKey}` unique partial `status: open`; `by_status_priority: {status, priority:-1, createdAt}` — queue                                                                                                                       |
| `professional_confirmation_operations` | `itemId`, `requestId?`, `decision`, `decisionHash`, `expectedItemRev`, `actor`, `attestation`, `state`, `result`, `outbox{derived, resume}`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `by_subject_created: {subjectId, createdAt:-1}`; `by_state_updated: {state, updatedAt}` partial `state: applied` — relay                                                                                                                                       |
| `professional_career_targets`          | `status`, `priority?` (ranked only), `spec{label, fit, viability, rationale?}`, `origin`, `basis`, `subjectEdited?`, `proposalEvidence?`, `rev`, `version`, `createRequestHash?`                                                                                                                                                                                                                                                                                                                                                                                                                    | `by_subject_status_priority: {subjectId, status, priority}`; `by_subject_status_created: {subjectId, status, createdAt:-1, _id:-1}`, `by_subject_created: {subjectId, createdAt:-1, _id:-1}` — history pages                                                   |
| `professional_career_target_versions`  | `targetId`, `version`, `spec`, `status`, `priority?`, `origin`, `basis`, `cause{kind, reason}`, `actor`, `attestation{mode}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `uniq_target_version: {targetId, version}` unique; `by_subject: {subjectId, createdAt:-1}`                                                                                                                                                                     |
| `professional_events`                  | `entity{kind, id}`, `type`, `from?`, `to?`, `reason`, `actor`, `operationId?`, `runId?`, `at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `by_subject_time: {subjectId, at:-1}`; `by_entity_time: {entity.kind, entity.id, at:-1}`                                                                                                                                                                       |
| `professional_review_items`            | `type` (`parser_failure`, `unsupported_format`, `limits_exceeded`, `extraction_suspect`, `fetch_failure`, `source_anomaly`), `dedupeKey`, `status`, `entity`, `reasonCode`, `allowedActions`                                                                                                                                                                                                                                                                                                                                                                                                        | `uniq_open_dedupe: {dedupeKey}` unique partial `status: open`; `by_status_priority`; `by_subject: {subjectId, createdAt:-1}` — erasure enumeration                                                                                                             |

**Validation.** Zod schemas are strict at the document top level and validate at the application
boundary; observation payloads are parsed with their claim type's schema and **stored
normalized** (ids and hashes use the normalized value, `observations/payload.ts`). Observation
provenance rules: an `ai` extractor requires AI metadata and never produces `stated`; `extracted`
requires a verified span and a quote; `preference.compensation` is never `inferred`; a skill
`proficiency` only comes from `stated` input. Server-side validators are the Foundation
derivation hardened stream-locally (`professionalValidator`): id-prefix and machine-code
patterns, string lengths, closed top level, and for sources a `$nor` that refuses
`linkedin_export` + `fetch` and any URL or fetch scope on the LinkedIn deny-list
(`linkedin.com`, `*.linkedin.com`, `lnkd.in`; `sources/linkedin.ts`, shared with the fetch
capability in P6). URLs are absolute `http(s)` only.

## 16. Package integration

- `scripts/check-architecture.ts`: `DOMAIN` gains `@aptamind/professional`; `ALLOWED` gets the same
  list as Market; `platform`, `api`, `worker` gain `professional`.
- `eslint.config.js`: shared packages may not import `@aptamind/professional`.
- `packages/platform`: `ensureProfessionalCollections` migration, `labels.subjectId` run index (`by_label_subject`, partial on `labels.subjectId` existing, via `ensureProfessionalRunLabelIndex`, also run by the lock-busy fallback),
  capabilities/AI tasks/workflows registration, `PROFESSIONAL` token, `ProfessionalDomain` in
  `Platform`.
- `apps/admin/lib/api-server/routes/professional.ts`; root `eval:golden` runs both domains' golden suites;
  `docs:data-model` and `docs:capabilities` include Professional.
