# Contract: Professional subject detail (overview, edit, archive, sources)

Owner: Professional. Consumer: Admin UX (subject record: overview, consent, sources tab, source
record). Status: **v1.2 (P1.3)** — overview, sources, uploads and snapshots (with their ingest
runs; the source record's evidence is [professional-source-detail](professional-source-detail.md)); profile sections, items and confirmation requests
join in P3.2/P3.3 (`professional-subject-detail` by section), the source record's evidence in
P1.3 (`professional-source-detail`). Conventions and error codes:
[professional-subject-list](professional-subject-list.md). Code:
`apps/admin/lib/api-server/routes/professional.ts`, `packages/professional/src/subjects/`,
`packages/professional/src/sources/`.

## GET /api/professional/subjects/:id — overview

```ts
{
  subject: SubjectDoc;                 // as in the list
  counts: {
    sources: number;
    sourcesByKind: Record<SourceKind, number>;   // every kind present, 0 when none
    snapshots: number;
    unprocessedSnapshots: number;      // processing pending or failed (P1.3); 0 for an archived subject
    observations: number;
    openReviewItems: number;           // operator data-quality items (not subject truth)
    targets: number;                   // open career targets (proposed, active, paused), P5.1
  };
  events: EventDoc[];                  // the subject's latest ≤ 20 events, newest first
}
```

`EventDoc`: `{ _id, entity: { kind, id }, type, from?, to?, reason, actor: { kind, id }, at }`.
Types in v1: `subject.created`, `subject.reference_changed`,
`subject.consent.data_class_changed`, `subject.consent.processing_basis_changed`,
`subject.consent.ai_processing_changed` (with `from`/`to` for enum fields),
`subject.archived` (`active → archived`), `source.registered` (entity = the source; `reason`
`kind_<kind>`), `snapshot.created` / `snapshot.reacquired` (entity = the snapshot; `to` =
`sourceAsOfKind`; `reason` `upload` or `form`), `snapshot.dated` (`acquired → declared`),
`extraction.completed` / `extraction.skipped` / `extraction.failed` (entity = the extraction;
`reason` a skip or error code, or `structured_form`). Events carry codes and states only; render
`type`/`reason` via labels.

404 `not_found` for an unknown id; 400 for a malformed id (must start `psub_`).

## PATCH /api/professional/subjects/:id — reference / consent

Body (at least one of `reference`, `consent`):

```ts
{ reference?: string; consent?: { dataClass?, processingBasis?, aiProcessing? }; expectedRev?: number }
```

Send `expectedRev = subject.rev` from the loaded view: if the subject changed meanwhile → 409
`stale_subject_revision` (reload). Each changed field writes an event in the same transaction;
a consent change also updates `consent.recordedBy/recordedAt`. Nothing changed → 200 with the
unchanged subject (no event, `rev` unchanged). Archived → 409 `subject_archived`.
Response 200 `{ subject }`.

## POST /api/professional/subjects/:id/archive

Response 200 `{ subject }` with `status: 'archived'`, `archivedAt`. Idempotent (archiving an
archived subject returns it unchanged, one `subject.archived` event). Archived subjects reject
edits and new sources (409 `subject_archived`). There is no unarchive in v1.

## Sources tab

### GET /api/professional/subjects/:id/sources

Query: `kind` (a source kind), `status` (`active \| archived`), `limit`, `cursor`, `sort` (list
conventions). Response `{ items: SourceDoc[], nextCursor, limit }`.

| Column      | Path                                                                             | Notes                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Kind        | `kind`                                                                           | `manual_input, questionnaire, cv, linkedin_export, github, portfolio, personal_website, case_study, certificate, uploaded_document`        |
| Authorship  | `authorship` (`subject \| platform \| issuer \| other`)                          | Who wrote the content                                                                                                                      |
| Acquisition | `acquisition` (`structured_input \| upload \| fetch`)                            | `linkedin_export` is always `upload`                                                                                                       |
| URL         | `url?`                                                                           | Stated URL (fetched website/portfolio) or `https://github.com/<handle>`. **Personal data**: never put it in logs, analytics or page titles |
| Ownership   | `ownership.state` (`intrinsic \| claimed \| confirmed \| disowned`)              | `claimed`: the subject has not confirmed the URL/handle is theirs (P6); show as "unconfirmed"                                              |
| Health      | `health.state` (`unknown \| ok \| degraded \| failing`), `health.lastErrorCode?` | `unknown` until the first acquisition                                                                                                      |
| Stats       | `stats.snapshots`, `stats.observations`, `stats.lastAcquiredAt?`                 |                                                                                                                                            |
| Created     | `createdAt`                                                                      |                                                                                                                                            |

Also: `policy.{hostScope[], maxPages}`, `externalRefKey?` (internal dedupe key; do not display),
`status`, `createdBy`.

### POST /api/professional/subjects/:id/sources — register

Headers: `Idempotency-Key` (recommended). Body:

```ts
{
  kind: SourceKind;
  acquisition?: 'structured_input' | 'upload' | 'fetch';   // default: the kind's first mode
  url?: string;          // required for fetched portfolio / personal_website; http(s) only
  handle?: string;       // required for github (GitHub handle rules)
  maxPages?: number;     // ≤ platform limit (default the limit)
}
```

Kind policy (form should offer only valid combinations):

| Kind                                                                      | Acquisition         | Needs              |
| ------------------------------------------------------------------------- | ------------------- | ------------------ |
| `manual_input`, `questionnaire`                                           | `structured_input`  | —                  |
| `cv`, `linkedin_export`, `case_study`, `certificate`, `uploaded_document` | `upload`            | —                  |
| `portfolio`                                                               | `upload` or `fetch` | `url` when `fetch` |
| `personal_website`                                                        | `fetch`             | `url`              |
| `github`                                                                  | `fetch`             | `handle`           |

Responses: **201** `{ source, created: true }`; **200** `{ source, created: false }` when the same
external source (same subject, kind and normalized URL / handle) or the same `Idempotency-Key`
was already registered (the existing source, unchanged). An `Idempotency-Key` sent with a
request that matched an existing source by natural key is bound to that source: replaying it
returns that source, also after the subject is archived. Requests are compared by meaning (normalized
URL / handle, resolved acquisition and page limit), so a differently spelled equal request is a
replay. Errors: 400 `validation_failed`
(`details.field` names the offending field: `acquisition`, `url`, `handle`, `maxPages`), 400
`linkedin_import_only` (LinkedIn fetch, or any `linkedin.com` / `linkedin.cn` / `lnkd.in` / `licdn.com` URL on any kind), 404
subject, 409 `subject_archived`, 409 `idempotency_key_reused`. Fetches and ingestion arrive with
P1.3+.

### GET /api/professional/sources/:id — source record (v1)

```ts
{ source: SourceDoc; snapshots: SnapshotDoc[]; extractions: ExtractionDoc[]; openReviewItems: ReviewItemDoc[] }
```

Snapshots (newest `sourceAsOf` first), extractions (newest first) and open data-quality items for
this source, ≤ 10 each; extractions and items are empty until P1.3 writes them. The full source
record contract (`professional-source-detail`) is published with P1.3.

`SnapshotDoc` (the source record's "Snapshots" table):

| Column        | Path                                               | Notes                                                                                                                          |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Document date | `sourceAsOf` + `sourceAsOfKind`                    | `declared`: the date the operator declared (authoritative); `acquired`: when the bytes were last received — always label which |
| Re-dated      | `previousSourceAsOf?`                              | `{ kind, value, replacedAt, acquisitionId }`: the received-time date a later declaration replaced (show as history)            |
| Type          | `mimeType`                                         | the declared media type, whose byte signature (or UTF-8 text) was checked — not a full format validation                       |
| Size          | `artifact.size` (with `include=sensitive`)         | bytes                                                                                                                          |
| Received      | `firstAcquiredAt`, `lastAcquiredAt`                | first / latest upload of identical bytes                                                                                       |
| Uploads       | `acquisitions`                                     | identical bytes are one snapshot; each accepted upload counts once; replays never count                                        |
| Content       | link to `/snapshots/:id/content?include=sensitive` | the only way to view the bytes; never via `/api/artifacts/*`                                                                   |

**Content hashes are sensitive** (supervisor ruling): a hash of short content is effectively
the value. `contentHash` and `artifact` (`artifactId`, `sha256`, `size`, `mimeType`, `createdAt`)
are returned only with `include=sensitive` — on uploads, statements, reprocess, snapshot lists,
the snapshot detail and the source detail — and `artifact.storageKey` never. Snapshot ids are
random (never derived from the content). Do not display hashes or artifact ids. The source
record shows the latest 10 snapshots by document date; **all** snapshots page through
`GET /api/professional/sources/:id/snapshots` (`limit`, `cursor`, `sort` over `createdAt`, list
conventions; no filters) → `{ items: SnapshotDoc[], nextCursor, limit }`.

### POST /api/professional/sources/:id/uploads — upload a document

The request body is the document's raw bytes; `Content-Type` is its media type. Optional query
`declaredAsOf=YYYY-MM-DD` (the document's own date, 1950-01-01 … UTC today + 1 day); no other
query parameter is accepted. Header `Idempotency-Key` (recommended: one key per user action).
Only sources registered with `acquisition: upload` take uploads. Size limit: the platform upload
limit (**10 MiB** by default, `limits.maxUploadBytes`).

| Kind                                           | Media types                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `cv`                                           | `application/pdf`, DOCX, `text/plain`, `text/markdown`              |
| `linkedin_export`                              | `application/zip`, `text/csv`                                       |
| `portfolio`, `case_study`, `uploaded_document` | `application/pdf`, DOCX, `text/plain`, `text/markdown`, `text/html` |
| `certificate`                                  | `application/pdf`, `image/png`, `image/jpeg`                        |

DOCX = `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. Text types must
be UTF-8. Before anything is stored the API checks the size, the media type for the kind, the
byte signature (or UTF-8 for text) and, for PDFs, an estimate of the page count against the
source's `maxPages`. DOCX page counts, pages inside compressed PDF streams and archive contents
are only checked by text extraction (P1.3/P2.1), which skips such documents with a code.

UI guidance:

- For document kinds (`cv`, `case_study`, `portfolio`, `certificate`, `uploaded_document`),
  prompt for the document's own date. An undated upload is dated by when it was received
  (`acquired`); a later upload of the same bytes with a date makes that date authoritative
  (`declared`; the received date stays as `previousSourceAsOf`). Declaring a different date for
  bytes that already carry one is refused (409 `conflict`, `declared_date_mismatch`).
- Show the subject's `consent.dataClass` next to the upload control. v0.1 accepts only
  `synthetic` or `owner_consented` subjects; a real person's documents require `owner_consented`
  (and, beyond testing, FE-P2 erasure).

Responses: **201** `{ snapshot, created: true }`; **200** `{ snapshot, created: false }` when
the source already has these exact bytes (a re-acquisition: `acquisitions` +1,
`lastAcquiredAt` moves, an `acquired` document date moves forward) or on an `Idempotency-Key`
replay of the same bytes, type and declared date (nothing changes; also after an archive). Since P1.3 the response also carries `runId` — the snapshot's ingest run (`null` while
unprocessed); see [professional-source-detail](professional-source-detail.md) for the upload →
ingest decisions.

| Status | `code`                   | When                                                                                                                                                                                                                                                     |
| ------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `validation_failed`      | empty body; bad `declaredAsOf`; unknown query parameter; `details.field`: `acquisition` (source does not take uploads), `source` (source not active)                                                                                                     |
| 404    | `not_found`              | unknown source                                                                                                                                                                                                                                           |
| 409    | `subject_archived`       | the subject is archived                                                                                                                                                                                                                                  |
| 409    | `conflict`               | `details.reason`: `idempotency_key_reused` (the key was used for other bytes, type or date), `declared_date_mismatch`; two concurrent requests with the same key and different declared dates may get either reason — treat both as "reload and resolve" |
| 413    | `upload_too_large`       | `details.limit`: `bytes` (above the upload limit, also for streamed bodies) or `pages` (PDF above the source's `maxPages`)                                                                                                                               |
| 415    | `unsupported_media_type` | `details.reason`: `media_type` (not allowed for the kind), `signature` (bytes are not that type), `encoding` / `charset` (text not UTF-8)                                                                                                                |

### GET /api/professional/snapshots/:id/content — the document bytes

**Requires `include=sensitive`** (supervisor ruling): a raw document or form can contain any
sensitive section, so the bytes of every snapshot are served only on that explicit opt-in;
without it the answer is exactly the unknown-snapshot 404 (`include` with any other value is
400). Link the Content column with `?include=sensitive` only in views meant to show the raw
document. Snapshot metadata (lists, source detail) needs no opt-in.

Subject-checked. Served as `text/plain; charset=utf-8` for textual types and
`application/octet-stream` with `content-disposition: attachment` otherwise, with
`x-artifact-mime-type: <mimeType>`, `x-content-type-options: nosniff`,
`content-security-policy: default-src 'none'; frame-ancestors 'none'`,
`cross-origin-resource-policy: same-origin` and `cache-control: private, no-store`, so a browser
never renders, frames or executes it. Show text types in a `<pre>`; offer other types as a
download. The Admin proxy must pass these response headers through unchanged. 404 `not_found`
for an unknown snapshot.

## Semantics the UI must not derive

- Consent gates AI: show `aiProcessing` as stated; do not infer it from `dataClass`.
- Ownership is a claim until confirmed; never present a `claimed` URL/handle as verified.
- Counts are live queries at request time, not cached snapshots.
