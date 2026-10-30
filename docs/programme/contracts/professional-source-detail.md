# Contract: Professional source detail (snapshots, extractions, evidence)

Owner: Professional. Consumer: Admin UX (the source record inside the subject detail, and the
evidence views). Status: **v1 (P1.3)** — structured input (manual input, questionnaire v1) and
uploads with their ingest runs; document text extraction joins in P2.1, resolution/items in
P2.4. Conventions and error codes: [professional-subject-list](professional-subject-list.md);
uploads, snapshot columns and the content route:
[professional-subject-detail](professional-subject-detail.md). Code:
`apps/admin/lib/api-server/routes/professional.ts`, `packages/professional/src/{sources,structured,extraction,observations}/`.

## GET /api/professional/sources/:id — source record

```ts
{ source: SourceDoc; snapshots: SnapshotDoc[]; extractions: ExtractionDoc[]; openReviewItems: ReviewItemDoc[] }
```

Latest ≤ 10 of each (snapshots by document date; all snapshots page through
`GET /sources/:id/snapshots`; one snapshot: `GET /snapshots/:id` → `{ snapshot }`). Every snapshot
in these responses (and in upload/statements/reprocess responses) carries a derived
**`processing`** object — use it, not the run view (generic run views may be restricted, FE-P7):

| `processing.state` | Meaning (derived from the extraction ledger and the run's state)                                                                                                                                           | UI                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `pending`          | no ingest run was ever started (launch failed or crashed)                                                                                                                                                  | **unprocessed**: Reprocess                   |
| `launched`         | the latest run is in flight                                                                                                                                                                                | processing…                                  |
| `processed`        | the structured extraction completed                                                                                                                                                                        | done                                         |
| `skipped`          | extraction terminal but skipped; `processing.reason` (e.g. `unsupported_format`)                                                                                                                           | show the reason                              |
| `failed`           | run failure — `reason`: `run_failed` (run FAILED/CANCELLED), `run_missing` (its run document is gone), `run_ended_without_extraction` (run COMPLETED, no extraction recorded): retried by a re-acquisition | **unprocessed**: Reprocess                   |
| `failed` + `final` | the extraction itself failed (`reason` = its code, e.g. `invalid_stored_form`): final — never retried automatically; Reprocess is 409 `extraction_failed_final`                                            | **unprocessed**: show the code, no Reprocess |

After an extractor version bump, a snapshot extracted by the previous version keeps its outcome
with `processing.olderExtractorVersion` (e.g. `processed` + `olderExtractorVersion: 1`): it is
not re-launched automatically and not counted as unprocessed unless that outcome was a failure;
Reprocess runs the current extractor (a failed extraction of an older version is not `final`).

`processing.runId` is the snapshot's **latest** ingest run (state, not history: it only moves to a
newer run). Other snapshot columns:

| Column     | Path                                  | Notes                                                                 |
| ---------- | ------------------------------------- | --------------------------------------------------------------------- |
| Launch     | `ingest.{state, runId, launchedAt}`   | raw launch record (`pending` \| `launched`); prefer `processing`      |
| Arrived as | `via` (`upload` \| `form` \| `fetch`) | `form` = statements or questionnaire answers; `fetch` arrives with P6 |

`ExtractionDoc` (one per snapshot and extractor version — the extraction ledger):

| Column    | Path                              | Notes                                                                                                                           |
| --------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Extractor | `extractor.{name, version, kind}` | P1.3: `structured_form@1`, `deterministic`                                                                                      |
| Status    | `status`                          | `completed` \| `skipped` \| `failed` (the schema also has `running`, unused in P1.3)                                            |
| Why       | `skipReason?`, `error.code?`      | `unsupported_format` = the structured extractor does not read this format (documents: their own extractors arrive in P2.1/P2.2) |
| Evidence  | `counts.observations`             | observations this extraction produced (see below)                                                                               |
| When      | `completedAt`, `runId?`           |                                                                                                                                 |

Text extractions (P2.1) will carry `textArtifact` and a section map: `textArtifact` and each
section's `hash` are content-derived and returned only with `include=sensitive` (offsets and
classes always); `textArtifact.storageKey` never.

A snapshot is processed once per extractor version: reprocessing a snapshot whose extraction
is terminal writes nothing (the run's `extract_structured` node reports `replayed: true`).

## POST /api/professional/subjects/:id/statements — structured input

Body `{ sourceId, form }` for a `manual_input` or `questionnaire` source of the subject
(`acquisition: structured_input`); `Idempotency-Key` (recommended). The form is stored as
submitted (canonical JSON) as a `form` snapshot of that source, with the same content
addressing, ledger and archive rules as uploads, and ingested.

- `manual_input` v1: `{ form: 'manual_input', version: 1, statements: [{ claimType, value }] }` (1–200),
  where `claimType` is one of the P2 claim types (`identity.name`, `identity.link`,
  `positioning.headline`, `experience.role`, `skill`, `education`, `certification`, `language`,
  `location.current`, `work_authorization`, `mobility.relocation`, `preference.remote`) and
  `value` its normalized value (domain doc §3.2).
  Derived fields are the extractor's: omit `concept`, `category`, `context` (skill),
  `language` (language), `titleKey` and `organization.key` (role), `institution.key`
  (education); a supplied value that disagrees is 400 `derived_field_mismatch`.
- `questionnaire` v1: `{ form: 'questionnaire', version: 1, answers }` with at least one of
  `headline`, `current_location`, `remote`, `relocation`, `work_authorization[]` (1–20),
  `languages[] { label, proficiency }` (1–30), `skills[] { label, kind?, proficiency? }` (1–200),
  `links[]` (1–20).

Responses **201** `{ snapshot, created: true, runId }`; **200** `{ snapshot, created: false,
runId }` for an identical form or a key replay. Errors: 400 `validation_failed` (`issues` with
paths/codes only; `details.field: sourceId` when the source is another subject's or of another
kind; `details.field: source` when the source is not active), 404 subject (checked first) or
source, 409 `subject_archived` / `conflict` (key reused).

## Upload → ingest (decisions, P1.3)

- The snapshot is written synchronously, so an upload or form answers **201/200** (not 202),
  with `runId` of its ingest run (`professional.source.ingest`).
- **One initial ingest run per snapshot.** A re-acquisition of identical bytes (and a key
  replay) returns the snapshot's latest run and starts no new one — identical bytes extract
  identically — unless the snapshot is unprocessed: `pending` (never started) launches the
  initial run; a run failure (`run_failed`, `run_missing`, `run_ended_without_extraction`)
  launches one retry run (keyed on the failed run, so concurrent re-acquisitions start one). A
  `final` failure is not retried.
- `runId: null` means no run could be started after the snapshot committed (launch failed, or
  the subject is archived): `processing.state` is `pending` and the subject overview counts it in
  `counts.unprocessedSnapshots` (pending + failed; 0 for an archived subject). It is never lost;
  **Reprocess** starts it.

## POST /api/professional/snapshots/:id/reprocess

Starts a new ingest run for a stored snapshot (optional `Idempotency-Key`: the same key returns
the same run). **202** `{ snapshot, runId }`; 409 `subject_archived`; 409 `extraction_failed_final`
(`details.reason` = the extraction's error code) when the current extractor already failed on it
(a new run would replay that failure); 404.

## Evidence (observations)

`GET /api/professional/subjects/:id/observations` — filters `sourceId`, `snapshotId`,
`claimType`, `status` (`current` \| `superseded` \| `quarantined`), `include=sensitive` + list
conventions → `{ items: ObservationDoc[], nextCursor, limit }`.
`GET /api/professional/observations/:id[?include=sensitive]` → `{ observation }`.

**Sensitive by default** (supervisor ruling, P1.3). Observations of sensitive claim types —
`location.current`, `work_authorization` (incl. `visaType`), `mobility.relocation`, and
`preference.compensation` / `preference.career` when they arrive — and observations carrying a
sensitive field of another claim type (`preference.remote` with a `timezoneWindow`: it reveals
approximate location; the same preference without one is standard) are returned only with
`include=sensitive`:

- lists exclude them without it; a `claimType` filter on a sensitive type without it is 400
  `validation_failed`;
- `GET /observations/:id` of a sensitive observation without it is the same 404 as an unknown id;
- `GET /snapshots/:id/content` serves the bytes of **any** snapshot (documents and forms) only
  with `include=sensitive`; without it it is the unknown-snapshot 404 (subject-detail contract).

Ask for `include=sensitive` only in views that need those values (eligibility), never by default.

**Allowed metadata** (L5): counts and locators are not hidden. `counts.observations` on an
extraction, the subject overview's counts and an observation's `evidence.locator` (a JSON pointer
such as `/answers/work_authorization/0`) can reveal that sensitive observations exist and how
many — not their values. This is accepted metadata for the operator views.

| Column     | Path                                                                                         | Notes                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim      | `claimType`, `payload`                                                                       | render per claim type (normalized value)                                                                                                                                   |
| Mode       | `mode`                                                                                       | `stated` (the subject's own structured answer), `extracted`, `inferred` — never show `stated` as verified                                                                  |
| Evidence   | `evidence.{locator, quote?, spanVerified}`, `evidence.artifactId` (with `include=sensitive`) | form: `locator` is the field's JSON pointer, `quote` the field as submitted (≤ 300 chars); the artifact id is content-derived (a hash oracle), so it is omitted by default |
| Chronology | `sourceAsOf`                                                                                 | the snapshot's document date at extraction time                                                                                                                            |
| Extractor  | `extractor.{kind, name, version}`, `extractionId`                                            |                                                                                                                                                                            |
| Resolution | `resolution.state`                                                                           | `pending` until P2.4 resolves observations into items                                                                                                                      |

Observations are append-only evidence, not truth: the canonical profile (P3) decides.

## Semantics the UI must not derive

- An observation is what a source said, not a fact about the subject; `stated` means the
  subject (via the operator) said it, not that it is confirmed.
- `skipped` is not an error: the format has no extractor yet.
- Do not open snapshot bytes through `/api/artifacts/*` (refused); use `/snapshots/:id/content`.
