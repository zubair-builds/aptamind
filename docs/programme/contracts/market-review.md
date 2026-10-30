# Contract: Market review queue (list, detail, resolve)

Owner: Market. Consumer: Admin UX (review inbox and review record). Status: **v2.4 (M11.5 attach-only items)** = v1
(`d9799b6`) + strict query validation and DTOs (M7.1) + list v2, facets and server-computed
actions and correctable fields (M7.5) + triage claims (API-9, PR #22) + role-axis-only
sponsorship corrections (PR #21, see "Sponsorship corrections").

Changelog: **v2.4** (M11.5) — attach-only `company_resolution` items for history registers (`context.attachOnly`, no `create_new`); history `source_anomaly` items per held fiscal year (`context { period, count, previousRows }`): `confirm` accepts that year's shrink for the next run of the snapshot, `retry` alone keeps it held. **v2.3** (M6.2 follow-ups) — `lifecycle_failure` auto-dismissal converges (and waits for an operator's resolution claim) and an operator's dismissal covers only its failure streak; the `claimed` filter row corrected (documentation). **v2.2** — role-axis-only `sponsorship` corrections (PR #21). **v2.1** —
`POST /api/review/:id/{claim,release}` (advisory, cooperative triage claims; holder token in the
body), `item.assignment`, list filter `claimed`. **v2** — M7.5 (with the PR #10 fixes:
`supportedActions` on the detail and with `include=actions`, `correctable[].current` as a
`SummaryFact`).
Conventions: [market-provenance](market-provenance.md). Code: `apps/admin/lib/api-server/routes/entities.ts`,
`packages/market/src/review/{review.repository.ts,review.service.ts,schemas.ts}`. Durability
model: `docs/architecture/market-domain.md` § Review queue, and ADR-0017.

## GET /api/review — queue (v2, M7.5)

List v2 conventions: [market-provenance § List v2](market-provenance.md#list-v2-conventions-m72m75).
Code: `packages/market/src/api/review.ts` (`reviewListQuerySchema`, `listReviews`).

| Query                               | Values                                                                                                                                                                                                         | Notes                                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit`, `offset`, `after`, `count` | see conventions                                                                                                                                                                                                |                                                                                                                                                                                                 |
| `status`                            | `open` (default) \| `resolved` \| `dismissed` \| `all`                                                                                                                                                         | `all` returns every status. An explicitly empty `status=` also means all (kept for v1 clients).                                                                                                 |
| `sort`                              | `priority`, `createdAt`, `updatedAt`; `-` = reverse                                                                                                                                                            | `priority` = highest priority first, oldest `createdAt` first within a priority. Default: `priority` for `open`/`all`, `-updatedAt` for `resolved`/`dismissed` (the v1 orders). `_id` tiebreak. |
| `type`                              | list of `company_resolution \| company_duplicate \| job_duplicate \| field_conflict \| employment_conflict \| salary_suspicious \| parser_failure \| source_anomaly \| careers_discovery \| lifecycle_failure` |                                                                                                                                                                                                 |
| `severity`                          | list of `low \| medium \| high`                                                                                                                                                                                |                                                                                                                                                                                                 |
| `entityKind`                        | list of `company \| job \| observation \| source`                                                                                                                                                              | `entity.kind`                                                                                                                                                                                   |
| `entityId`                          | id                                                                                                                                                                                                             | `entity.id` **or** any `candidates[].id`                                                                                                                                                        |
| `scopeId`                           | id                                                                                                                                                                                                             | `entityId`'s matches **plus** items whose retry source is it (`context.sourceId`): everything to show on a source or record page.                                                               |
| `resolving`                         | `true \| false`                                                                                                                                                                                                | a resolution is in progress (`claim` set) / not                                                                                                                                                 |
| `hasFailure`                        | `true \| false`                                                                                                                                                                                                | a previous decision failed (`lastFailure` set) / not                                                                                                                                            |
| `claimed`                           | `true \| false`                                                                                                                                                                                                | `true`: the item is open **and** has a live triage claim (API-9: `assignment` set and not expired); `false`: no claim, an expired one, or a closed item                                         |
| `createdAfter`, `createdBefore`     | date or ISO date-time                                                                                                                                                                                          |                                                                                                                                                                                                 |
| `facets`                            | `true \| false` (default false)                                                                                                                                                                                | adds `facets` (below)                                                                                                                                                                           |
| `include`                           | `actions`                                                                                                                                                                                                      | also compute `supportedActions` per row (read-only probes; at most 4 items at a time). Without it list rows have **no** `supportedActions`; the detail always has them.                         |

`priority` = 300/200/100 for severity high/medium/low, plus a type boost. Unknown parameters and
bad values are 400.

Response `ListPage<ReviewListItem>` (DTO `reviewListV2ResponseDto`; v1 readers of
`items/total/limit/offset` are unaffected), plus with `facets=true`:

```ts
facets: {
  type: Partial<Record<ReviewType, number>>; // counts under every filter except `type`
  severity: Partial<Record<'low' | 'medium' | 'high', number>>; // counts under every filter except `severity`
}
```

`ReviewListItem` = `ReviewItemDoc` plus server-computed fields (DTO `reviewListItemDto`):

```ts
queueState: 'open' | 'resolving' | 'failed' | 'resolved' | 'dismissed';
supportedActions?: ReviewAction[] | null; // actions a probe passed (see below); [] when closed or resolving.
                                     // List: only with include=actions. null = the probes failed
                                     // transiently for this item (the rest of the page is fine; refetch)
correctable: CorrectableField[];     // fields `correct` may set, targeted first; [] when `correct` does not apply
targetFields: string[];              // the correctable fields this item is about (e.g. ['workModel'])

CorrectableField = {
  field: string;                     // send as `field` with action `correct`
  path: string;                      // the fact on the entity, e.g. 'geography.workModel'
  type: 'enum' | 'string' | 'object';
  values?: string[];                 // enum: the allowed values
  schema?: 'remoteScope' | 'sponsorship' | 'compensation'; // object: the full value shape (provenance contract)
  targeted: boolean;
  current: SummaryFact<unknown>;     // the fact's current canonical state: { value (null when unknown),
                                     //   status: known|unknown|conflicting, confidence {level, score?},
                                     //   basis, alternates } — never a bare value (companies contract)
}
```

Item fields to render: `type`, `severity`, `subject` (one line, human readable), `reason`,
`entity {kind: company|job|observation|source, id}`, `candidates[] {kind, id, label, score?,
details?}`, `occurrences` (how often the same question recurred), `createdAt`, `updatedAt`,
`queueState`, `supportedActions`, `claim?` (resolution in progress), `lastFailure?`,
`resolution?`.

**States of an item** (`queueState`, server-computed):

| `queueState` | Condition                                    | UI                                                                                                                                        |
| ------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `open`       | `status: open`, no `claim`, no `lastFailure` | actionable (`supportedActions`)                                                                                                           |
| `resolving`  | `status: open`, `claim` set                  | read-only badge: `claim.action` by `claim.actor`. A crashed resolution is recovered automatically (≤ 10 min stale window + hourly sweep). |
| `failed`     | `status: open`, `lastFailure` set            | show `lastFailure.message` ("previous decision could not be applied: …") and allow a corrected decision (`supportedActions`)              |
| `resolved`   | `status: resolved`                           | show `resolution {action, reason, value?, targetId?, actor, at, result?}`                                                                 |
| `dismissed`  | `status: dismissed`                          | show `resolution`                                                                                                                         |

**`supportedActions` (M7.5)** replace the client-side rule of v1: offer exactly these actions.
Each is `allowedActions` ∩ (`confirm`, `dismiss`, the type's effect actions) for which **a probe
passed**: one probe decision ran through the resolver's own validation now (read-only) and was
accepted. A targeted action (`merge`, `keep_separate`) is listed when at least one existing
candidate is a valid target; `correct` when at least one correctable field accepts a probe value
(its current value, else the first enum value); `retry` when the source exists, is enabled and
runs can be launched. It is **not** a promise that every target or value is accepted: the server
validates each submitted decision (a specific target or value can still be rejected with 400).
Probing costs a few indexed reads per action, so the list computes them only on request
(`include=actions`, candidates prefetched in one query per kind, bounded concurrency); open the
item (detail) to get them for one item. A transient failure while probing yields
`supportedActions: null` for that item only (log line `supported-action probes failed`).

**Breaking vs the first M7.5 cut (unreleased):** list rows carry `supportedActions` only with
`include=actions`; `correctable[].current` is a `SummaryFact` (it was the bare value).

**Gaps:** grouping and bulk resolve → **M12.3**. Triage claims (API-9): see below; there is no
"assign to another operator" in v0.1 (no user identities, ADR-0008).

Indexes: `by_status_priority`, `list_created`, `list_updated` (sorts, keyset), `by_entity`,
`by_candidate`, `by_context_source` (`entityId`/`scopeId`), `by_type_status`. Sorting `status=all`
has no status prefix, so it is sorted in memory over the matches (bounded by `limit`).

## GET /api/review/:id — detail

DTO `reviewDetailResponseDto`:

```ts
{
  item: ReviewListItem;                              // the list row: + queueState, supportedActions (always computed here;
                                                     // null = transient probe failure), correctable, targetFields (M7.5)
  entity: CompanyDoc | JobDoc | SourceDoc | null;   // the item's subject (observation-kind → null)
  observations: (CompanyObservationDoc | JobObservationDoc)[]; // item.observationIds + context.observationId:
                                                     // company ≤20, then job ≤20 (M7.5: job observations always included)
  candidates: (Candidate & { entity: projected CompanyDoc{identity,geography,employment,quality}
                                   | projected JobDoc{identity,geography,lifecycle,sourceRefs} | null })[];
  audit: AuditEventDoc[];                            // events of this review item, ≤20
  targetedFacts: { field, path, fact: Fact | null }[]; // M7.5: the full facts (evidence, conflicts) of targetFields
}
```

Any query parameter is a 400.

`item.context` is type-specific JSON (for example `{flag, observationId}` for employment
conflicts; `{originalText, status}` for salary; `{fields}` for field conflicts; `{sourceId,
snapshotId}` for parser and source problems; `{ats[]}` for several boards). A `parser_failure`
for unmappable listing entries (M6.1; one open item per source, `occurrences` counts the runs)
adds `{entries, mapped, malformed, unlisted, warnings, complete, adapterVersion,
sample: string[≤5]}`. It is keyed by source, adapter version and the set of malformed entries
(PR #11 B-M4). Once an operator dismisses an item on a key, the same set is not raised again. A
new set or adapter version raises a new item and dismisses the source's older open one as
superseded (system actor `market-parser-findings`). A supersession is not an operator decision:
if the superseded set comes back, it is raised again. A regional-duplicate `careers_discovery`
(M6.3; subject "… is EU-hosted but also registered on the default host") has `{sourceId,
legacySourceId, regionalSourceId}`: the legacy default-host source and the regional one. A
job-listing shrink `source_anomaly` (M6.2; subject "listing shrank from B to N jobs (no jobs
closed)" or "listing returned no jobs") has `{sourceId, snapshotId, baselineCount, count,
baselineSnapshotId, baselineAt, baselineEndpointChangedAt}`; one open item per source baseline.
While it is open, each recurrence refreshes its `subject`, `reason` and `context` (so `count` is
the latest held size), unless it is being resolved (`claim` set). Render it as key/value pairs;
do not rely on its shape beyond these examples: the field a decision should target is
`item.targetFields` / `targetedFacts` (M7.5), not a client reading of `context`.
`item.evidence[]` holds EvidenceReferences.

## POST /api/review/:id/claim, POST /api/review/:id/release — triage claims (API-9)

An **advisory, cooperative** claim: an operator marks an open item as theirs while working on it,
so two operators do not pick the same item. It is not the resolution claim of ADR-0017
(`item.claim`, shown as `queueState: resolving`); `POST /resolve` neither requires nor checks it —
the durable operation alone guarantees one decision. Code: `packages/market/src/review/triage.ts`.

- **Holder = body field `holder`**: a client token, 8–128 characters of `[A-Za-z0-9_-]` (e.g. one
  random token per browser session). v0.1 has no user identities (ADR-0008), so the token is how a
  client recognises its own claim; it is stored only as `holderHash` (sha-256) and never echoed.
  When authentication arrives, the holder becomes the request's actor.
- **`Idempotency-Key` is a different concept**: optional, 1–200 characters, one per claim/release
  _attempt_; a replayed attempt records no second audit event. It is not the holder, and it is
  not the key you send with `resolve` (that one names a decision attempt). Neither key is stored
  or returned raw.
- `POST /claim`, body `{ holder, ttlMinutes?: 1–240 (default 30) }` (strict). 200 `{ item }` with
  `item.assignment = { holderHash, actor, claimedAt, expiresAt }`. The same holder again **renews**
  (keeps `claimedAt`, moves `expiresAt`). Another holder while the claim is live → **409**
  `conflict`, `details.assignment = { holderHash, claimedAt, expiresAt }`. A closed item → 409.
  Unknown item → 404. Concurrent claims: exactly one wins.
- `POST /release`, body `{ holder, force?: false }`. The holder's token removes the claim: 200
  `{ item }` without `assignment`. No live claim → 200 unchanged (idempotent). Another holder's
  live claim → 409, unless `force: true`: claims are cooperative, **any client can release** an
  item (audited as `review.claim_forced_release` with `details.displacedHolderHash`). Only a live
  claim is ever released: an expired claim or a closed item → 200 unchanged, nothing audited (with
  or without `force`). Closing an item (resolve/dismiss) removes its claim.
- **Expiry**: a claim lapses at `expiresAt` (at most 240 minutes after the last claim/renewal).
  An expired claim blocks nobody and is omitted from list rows, the detail and the claim/release
  responses. `claimed=true` means open **and** a live claim; closed items are never claimed.
- **Audit**: `review.claimed`, `review.released`, `review.claim_forced_release` on the review item
  (`entity: { kind: 'review_item', id }`), never on the job/company trail, without the holder;
  renewals are not events.
- DTO `reviewTriageResponseDto`. Render "claimed by you" when `assignment.holderHash` equals the
  sha-256 of your token (`triageHolderHash`), else "claimed until `expiresAt`".

## POST /api/review/:id/resolve

Body (`resolveReviewInputSchema`, `review.service.ts`):
`{ action, reason (3–2000 chars, required), targetId?, field?, value?, evidenceHash? }`.
**`evidenceHash`** (If-Match, DECISION_LOG bc013e8): send the item's `context.evidenceHash` as it
was shown. When the item's evidence has changed since (reconciliation refreshes an open item's
`subject`, `reason`, `evidence`, `observationIds` and `context` together), the decision is refused
with 409 `conflict` (`details.reason: 'evidence_changed'`) — reload the item and decide again.
The check is the claim itself: ONE compare-and-set on `{status: open, context.evidenceHash: sent}`
(owning the operation record is the mutex, so a leftover claim marker from an interrupted release
never blocks a decision); no refresh can land between the check and the claim; on no match the
operation is released and nothing is decided. A claim on an item that is no longer open is a 409
with `details.reason: 'not_open'`. The sent digest is stored on the operation (`shownEvidenceHash`):
a resume (same `Idempotency-Key`) or a recovery applies the stored decision only while the item
still carries that digest, else releases it. Without `evidenceHash` the decision covers the digest
and stating set the claim saw (a claimed item is no longer refreshed), which always match each
other. Items without `context.evidenceHash` (not raised by job reconciliation) accept any decision,
with or without `evidenceHash`.
**Plan (Admin follow-up):** the Admin does not send `evidenceHash` yet. Once it does, the API will
require it for job-reconciliation items (428 Precondition Required when missing); until then it
stays optional. Header
**`Idempotency-Key`** (≤ 200 chars) is recommended: send one per decision attempt and re-send the
same key when retrying after a timeout. It resumes your own operation instead of returning 409.

Response 200: `{ item: ReviewItemDoc }` (closed: `resolved` or `dismissed`; DTO
`reviewResolveResponseDto`).

Offer `item.supportedActions` (M7.5). The domain policy behind them (for reference; the UI no
longer computes it) — effect actions by type:

| Type                                                         | Effect actions                  | Required inputs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `company_resolution`                                         | `merge`, `create_new`, `reject` | `merge`: `targetId` = a candidate id (implied when there is exactly 1 candidate). `create_new` is refused when it would clash with an active company's identity (the message says to merge instead). **Attach-only items (M11.5, `context.attachOnly: true`, `context.register`):** a history-register row (H-1B) whose match is ambiguous; `allowedActions` are `merge`, `reject`, `dismiss` only — history never creates a company (`create_new` is refused). One item per register, employer and state across fiscal years (`observationIds` grows). A decision covers the rows it lists: a closed item re-raises for the next fiscal year's row (a merge is not proof for later rows; add the company's US location so later rows attach automatically). |
| `company_duplicate`, `job_duplicate`                         | `merge`, `keep_separate`        | `targetId` a candidate. Merge keeps the **older** entity as survivor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `field_conflict`, `employment_conflict`, `salary_suspicious` | `correct`, `retry`              | `correct`: `field` + `value`. Job fields: `workModel` (enum string), `remoteScope`, `sponsorship`, `relocation` (enum string), `compensation`, `employmentType` (enum string). The value is the **full value shape** of that fact (provenance contract). Company fields: `identity.domain`, `identity.website`, `identity.displayName` (non-empty string). `retry` recomputes derived state only.                                                                                                                                                                                                                                                                                                                                                            |
| `parser_failure`, `source_anomaly`, `careers_discovery`      | `retry`                         | Re-runs the source (`context.sourceId` or the entity source). Refused if the source is missing or disabled. The run starts asynchronously; its id appears in `resolution.result`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lifecycle_failure`                                          | — (`dismiss` only)              | — (informational; dismissed automatically on recovery, below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**Sponsorship corrections decide only the role (PR #21, ruling A-M3/B-M1, `job-policy/3`).** A
`correct` of `sponsorship` accepts `status` `explicit_yes`, `explicit_no` or `unclear`, with the
matching `roleStatement` (`yes`, `no`, `none`). `company_capable` and `historical_evidence` describe
the company. They are refused with 400 `validation_failed` ("decides only the role … correct the
company instead"). In the value sent, `companyCapability` and `capabilityCountries` are **ignored**:
they are recomputed from current company evidence on every reconciliation. Show them read-only in
the correction form. Retroactive meaning under `job-policy/2`+: an override recorded earlier keeps
its role axes, but its company axis now follows the company. A stored override with a company-axis
status (none in production) is not applied: the status is re-derived and one `field_conflict`
("stored sponsorship override was not applied") asks for a new decision. Correcting a wrongly
matched licence is a company-level action (a follow-up, M11.5 / company review), not a job
correction.

`confirm` and `dismiss` have no immediate domain effect (confirm = "the current value is right").
One exception is read later by automation: a **job-listing shrink** `source_anomaly` (M6.2) that
is resolved with `confirm` means "the board really shrank". The source's next listing is then
applied (its absences count) unless it shrinks again below the confirmed size. The confirmation
applies only to the baseline it was raised for. `dismiss` or `retry` keeps the guard in place,
and a later `dismiss` of an item on the same baseline revokes an earlier `confirm` (the latest
confirm-or-dismiss decision stands).

Pre-M6.2 empty-listing items (`dedupeKey` `source_anomaly:<sourceId>:empty`) are no longer read
by automation. At startup, Market dismisses any still open, as the system actor
`market-review-migration`, with an audited reason ("Superseded by the M6.2 listing shrink
guard…"). A listing that is still held raises a per-baseline item on its next refresh.

Errors:

| HTTP | code                | Meaning and UI response                                                                                                                                                                                       |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `validation_failed` | Invalid decision (action not allowed or supported, missing or invalid target, field or value, identity clash, source disabled). **Nothing was persisted**; the item stays open. Show `message` and `details`. |
| 409  | `conflict`          | Someone else is resolving it, or it was already resolved with a different decision. Refetch the item.                                                                                                         |
| 404  | `not_found`         | Unknown item.                                                                                                                                                                                                 |
| 5xx  | —                   | Transient. Retry with the **same** `Idempotency-Key`.                                                                                                                                                         |

## Semantics the UI must respect

- Decisions are applied through the same domain services as automation, are audited
  (`market_audit_events`), and resume any workflow waiting on the item. A resolved item is never
  reopened; a recurring question creates a new item (`dedupeKey`).
- Merges are irreversible in v0.1 (there is no unmerge). Confirm them in the UI and show both
  records side by side (`candidates[].entity`).
- `company_duplicate` and `company_resolution` mean the resolver would not auto-merge. Present
  the evidence neutrally; do not pre-select merge.
- The field to correct is `targetFields` (M7.5; e.g. an `employment_conflict` on a work-model flag
  targets `workModel`). Pre-select it, but let the operator pick any `correctable` field: the
  target is derived from the flag or the conflicting fields and can be empty.
- `careers_discovery` items (several ATS boards; a board owned by another company; a regional
  board also registered on the default host) can only be confirmed or dismissed today: there is
  no board selection and no merge. **`confirm` does nothing yet** — for the regional duplicate
  it does not disable `legacySourceId`; the operator disables that source
  (`PATCH /api/sources/:id` `{enabled: false}`). M8.7 makes them actionable.
- `lifecycle_failure` (PR #11 re-verify #12, additive): a job's lifecycle could not be re-derived
  from its evidence in 3 consecutive recorded-evidence sweeps. `entity` is the job; `context` is
  `{ jobId, code, failures }` (an error code, never a message). `allowedActions` is `['dismiss']`
  only (no effect action): the sweep keeps retrying the job and refreshes the item while it keeps
  failing. When the job re-derives successfully the item is dismissed automatically by the system
  (actor `market-lifecycle-recovery`, reason "The job's lifecycle was re-derived successfully.").
  That dismissal converges (M6.2): until it succeeds the job stays on the sweep's retry list and
  it is retried, and an item raised by a sweep that overlapped the recovery is dismissed too. An
  item an operator is deciding — a live **resolution** claim (`claim` set,
  `queueState: resolving`) — is never taken: the job stays on the retry list and the dismissal is
  retried after the operator finishes (then nothing is left to dismiss) or releases. A **triage** claim (API-9,
  `assignment`) is advisory and does not hold off the system dismissal. An operator's decision is
  never overwritten (a stale resolution claim is recovered as for any item: it completes the
  operator's stored decision). After an operator dismisses it, it is not raised again for the
  same `code` during the same failure streak — a new streak (after the job recovered) or another error code
  raises it again (M6.2). Show "stored lifecycle may be out of date"; engineering follows up on
  `code`.
- Every resolved `correct` on a job semantic field will produce a golden-regression candidate
  (M12.2). Ask the operator for a meaningful `reason`.
