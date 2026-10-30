# Contract: Professional career targets (list, detail, edit, status, reorder, versions)

Owner: Professional. Consumer: Admin UX (subject record → Targets tab, target record, target
history). Status: **v1 (P5.1)**. Code: `apps/admin/lib/api-server/routes/professional-targets.ts`,
`packages/professional/src/targets/` (service, lifecycle `transitions.ts`, `views.ts`), spec
schema `targetSpecSchema` in `packages/professional/src/contracts/targets.ts`. Conventions and
shared error codes: [professional-subject-list](professional-subject-list.md).

A **career target** is a direction the subject is pursuing. A subject has any number of
simultaneous targets. Every target has a stable id (`ptgt_…`) and a version; every change
creates a new immutable version, so `(targetId, version)` always names exactly one state
(PL-13). Nothing is ever deleted: archived and declined targets stay readable with their full
history. Targets carry **no eligibility** (no work authorization, visa or sponsorship field
exists; R-28) and **no fit score or job matching** (Opportunity Intelligence is out of scope).

## The target document

```ts
CareerTarget {
  _id: string;                 // ptgt_…
  subjectId: string;
  status: 'active' | 'paused' | 'proposed' | 'declined' | 'archived';
  priority?: number;           // ranked targets only (active, paused): 1 = highest, unique per subject
  spec: {
    label: string;             // short name, shown in lists
    fit: {                     // capability-relevant: what kind of work
      roleFamilies: RoleFamily[];            // ≥ 1, taxonomy codes
      specializations?: Specialization[];
      titles?: string[];
      seniority: { min?: SeniorityLevel; max?: SeniorityLevel };
      skillsFocus?: { label: string; concept: string | null }[];
      industries?: IndustryCode[]; domains?: string[]; excludedIndustries?: IndustryCode[];
      companyStages?: CompanyStage[]; employmentTypes?: EmploymentType[];
    };
    viability?: {              // SENSITIVE — only with include=sensitive
      geography: { scope: 'country'|'region'|'city'|'anywhere'; code?: string; city?: string;
                   mode: 'live_in'|'commute_to'|'remote_from' }[];
      workModels?: { acceptable: ('remote'|'hybrid'|'onsite')[]; preferred?: … };
      remoteScope?: { timezoneWindow?: { minUtcOffset: number; maxUtcOffset: number } };
      compensation?: { currency; min?; target?; period; basis; negotiable? };
      constraints: { kind: 'start_date'|'max_travel'|'contract_length'|'other'; value: string;
                     strength: 'hard'|'soft' }[];
    };
    rationale?: string;        // SENSITIVE (free text) — only with include=sensitive
  };
  origin: 'stated' | 'proposal' | 'accepted_proposal';
  basis: 'confirmed' | 'inferred';     // stated/accepted = confirmed; proposals (P5.2) = inferred
  subjectEdited?: true;        // a proposal the subject edited: still proposed, now subject-owned;
                               // kept after the proposal is accepted or declined
  rev: number;                 // send as expectedRev on every change
  version: number;             // current version number (1 on creation)
  createdBy: { kind; id }; createdAt; updatedAt;
  fitHash: string;             // sha-256 over { label, fit } as stored: drift pin for the fit part
                               // (like factsHash); array order counts and a rename changes it
  sensitive: 'omitted' | 'included';   // whether spec.viability / spec.rationale are in this response
}
```

**Fit ≠ viability.** `spec.fit` is what a future fit computation may read; `spec.viability` is
where and on which terms the subject can work (location, relocation — `live_in` somewhere other
than today — commuting, remote-from, work models, timezone window, compensation, constraints).
Show them as separate panels; never merge them into one "preferences" block and never derive one
from the other.

**Sensitive data (R-30).** Without `?include=sensitive` every response omits `spec.viability` and
`spec.rationale` and says `sensitive: 'omitted'` — render "Hidden (sensitive)" with a reveal
action that reloads with `include=sensitive`, never an empty state. **Writing** viability or a
rationale also requires `include=sensitive` (otherwise `400 sensitive_not_included`); an edit that
omits them keeps the stored values.

**Basis.** A target the subject stated (operator-relayed in v0.1) or accepted is `confirmed`; a
proposal derived from evidence (P5.2, status `proposed`) is `inferred`. Automation can never
change a confirmed target; show `inferred` proposals distinctly, with accept/decline actions.
Target basis is not profile basis: a profile item's `confirmed` means the subject confirmed a
value that evidence proposed (a confirmation operation, §7 of the domain doc); a target is the
subject's own statement, so a target the operator entered on the subject's behalf is `confirmed`
from creation (attestation `operator_relayed` on each version) — it asserts intent, not a fact
about the subject's history. Automation never overwrites the subject's input: once the subject
edits a proposal it is marked `subjectEdited` (still `proposed` and `inferred` until accepted)
and automation can no longer edit it; automation may only edit proposals it created itself.

**Input hints for Admin.** Labels, titles and domains are about the work only: they must not
carry location, compensation or work authorization (put geography and compensation in the
viability panel). Work authorization, visa and sponsorship belong in the subject's eligibility
claims — never in a target, including `constraints` (constraints are start date, travel,
contract length or a short "other" note). Use `fit.employmentTypes` for the kind of engagement
(full-time, contract, …) and a `contract_length` constraint for how long a contract may be. Show
a hint next to the free-text fields ("no location, pay or visa details here") and keep the
viability panel collapsed and marked sensitive.

## Endpoints

| Method & path                                                                | Body                                                                  | Response                                     |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| `POST /api/professional/subjects/:id/targets`                                | `{ label, fit, viability?, rationale?, status?: 'active'\|'paused' }` | 201 `{ target, created: true }` / 200 replay |
| `GET /api/professional/subjects/:id/targets`                                 | query `status?`, `limit?`, `cursor?`, `sort?`, `include?`             | 200 `{ items, nextCursor, limit }`           |
| `POST /api/professional/subjects/:id/targets/reorder`                        | `{ order: [{ targetId, expectedRev }] }`                              | 200 `{ items }` (new order)                  |
| `GET /api/professional/targets/:id`                                          | query `include?`                                                      | 200 `{ target, events }`                     |
| `PATCH /api/professional/targets/:id`                                        | `{ expectedRev, label?, fit?, viability?, rationale? \| null }`       | 200 `{ target }`                             |
| `POST /api/professional/targets/:id/{activate,pause,archive,accept,decline}` | `{ expectedRev }`                                                     | 200 `{ target }`                             |
| `GET /api/professional/targets/:id/versions`                                 | query `limit?` (1–100, default 50), `cursor?`, `include?`             | 200 `{ items, nextCursor, limit }`           |
| `GET /api/professional/targets/:id/versions/:n`                              | query `include?`                                                      | 200 `{ version }`                            |
| `GET /api/professional/targets/:id/diff?from=&to=`                           | query `include?`                                                      | 200 `TargetDiff`                             |

- **Create.** `Idempotency-Key` recommended: a replay returns the same target (200, `created:
false`); the same key with another body is `409 idempotency_key_reused`. New ranked targets get
  the next priority (last). `viability` omitted = unknown (`geography: [], constraints: []`). At
  most 100 **open** targets (proposed, active, paused) per subject (`409 target_limit_reached`);
  archived and declined targets do not count. Sending `viability` or `rationale` without
  `include=sensitive` is refused before the body is validated (`400 sensitive_not_included`).
- **List.** Default (no `status`, or `status=active|paused|proposed`): the open targets, not
  paginated (≤ 100) — active and paused by priority, then proposed (newest first);
  `nextCursor: null`. `status=archived|declined|all`: history, keyset-paged over `(createdAt, _id)`
  with `limit` (1–100, default 25), `cursor` and `sort` (`-createdAt` default) as in all
  Professional lists; `limit`/`cursor`/`sort` with an open status → `400 validation_failed`.
- **Detail.** `events`: the target's latest ≤ 20 events (`target.created`, `target.spec_edited`,
  `target.status_changed` with `from`/`to`, `target.reordered`), codes only.
- **Edit.** Each given part replaces the current one (`fit` and `viability` are replaced whole,
  `rationale: null` clears it). An edit that changes nothing returns the target unchanged (no new
  version). Send `expectedRev = target.rev`; if the target changed meanwhile → `409
stale_target_revision` and nothing is written — reload and let the operator re-apply.
- **Status actions** (lifecycle below). An action not legal from the current status → `400
illegal_transition`. Archiving drops the priority; re-activating an archived target puts it
  last. Re-opening counts
  towards the cap: `activate` of an archived target at 100 open targets → `409
target_limit_reached` (archive another first).
- **Reorder.** `order` lists **every** ranked (active + paused) target exactly once, highest
  first, with the `rev` shown. Priorities become 1…n in one transaction: a missing/extra target →
  `409 target_order_mismatch`, any stale `rev` → `409 stale_target_revision`; either way nothing
  changes. Only targets whose priority changed get a new version (a reorder is a real change of
  those targets: their `rev` and `version` move and their history shows `cause.kind:
'reordered'`). Drag-and-drop: send the full list, then replace the list with the response
  (the open targets). A subject without ranked targets accepts an empty `order` as a no-op
  (200); an empty `order` when ranked targets exist is `409 target_order_mismatch`.
- **Versions.** `CareerTargetVersion { _id, targetId, version, status, priority?, spec, origin,
basis, cause: { kind: 'created'|'spec_edited'|'status_changed'|'reordered', reason }, actor,
attestation: { mode: 'operator_relayed'|'automation' }, subjectEdited?, fitHash, createdAt,
sensitive }`, oldest first, keyset-paged (`nextCursor`); the same sensitive rule applies.
- **Diff.** `{ targetId, from, to, changes: [{ path, from?, to?, sensitive? }], sensitive }`;
  `path` ∈ `status`, `priority`, `basis`, `spec.label`, `spec.fit.<field>`,
  `spec.viability.<field>`, `spec.rationale`. Without `include=sensitive`, viability/rationale
  changes are listed by path with `sensitive: true` and no values — so a diff does reveal
  **which** sensitive field changed (metadata only, e.g. "compensation changed"), never to what.

## Lifecycle

| From → To                         | Action     | Who                                                         |
| --------------------------------- | ---------- | ----------------------------------------------------------- |
| — → `active` \| `paused`          | create     | subject (operator-relayed)                                  |
| — → `proposed`                    | (propose)  | automation, P5.2                                            |
| `proposed` → `active`             | `accept`   | subject (origin → `accepted_proposal`, basis → `confirmed`) |
| `proposed` → `declined`           | `decline`  | subject (terminal)                                          |
| `paused` → `active`               | `activate` | subject                                                     |
| `archived` → `active`             | `activate` | subject (restore; placed last)                              |
| `active` → `paused`               | `pause`    | subject                                                     |
| `active` \| `paused` → `archived` | `archive`  | subject                                                     |

Spec edits: the subject while `proposed`, `active` or `paused`; automation only a proposal it
created itself, while it is `proposed` and not `subjectEdited`. A stale `expectedRev` is always
`409 stale_target_revision`, checked before whether the action is legal (reload first). Archived
subjects are read-only (`409 subject_archived`).

## Errors (in addition to the shared ones)

| Status | `code`                   | Meaning / UI                                                             |
| ------ | ------------------------ | ------------------------------------------------------------------------ |
| 400    | `sensitive_not_included` | Viability or rationale sent without `include=sensitive`                  |
| 400    | `illegal_transition`     | The action is not legal from the current status (or for this actor)      |
| 404    | `not_found`              | `details.entity` = `career_target` or `career_target_version`            |
| 409    | `stale_target_revision`  | The target changed since it was loaded — reload                          |
| 409    | `target_order_mismatch`  | The reorder list is not exactly the current ranked targets — reload      |
| 409    | `target_limit_reached`   | 100 open targets: create, or activate from archived — archive some first |
| 409    | `subject_archived`       | The subject is archived — targets are read-only                          |

## Permission assumptions

v0.1 has no authentication (ADR-0008): requests act as the internal operator, whose changes are
recorded as `operator_relayed` subject attestations. Every route resolves the owning subject and
passes it through `assertSubjectAccess` (the future authorization point); `include=sensitive` is
the future authorization point for viability data.
