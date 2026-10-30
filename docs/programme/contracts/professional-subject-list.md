# Contract: Professional subjects (list, create)

Owner: Professional. Consumer: Admin UX (subject list, new-subject form). Status: **v1 (P1.1)**.
Code: `apps/admin/lib/api-server/routes/professional.ts`, `packages/professional/src/subjects/subject.service.ts`,
schema `subjectDocSchema` in `packages/professional/src/subjects/subject.schema.ts`. Detail and
sources: [professional-subject-detail](professional-subject-detail.md).

A **subject** is the professional Aptamind holds evidence about. The subject document carries
**no personal data**: `reference` is an opaque operator token (letters, digits, `_ . : -`; never a
name or email). All requests are made as the unauthenticated internal operator (ADR-0008); the
API is internal only.

## Conventions (all Professional lists)

- Query parameters are strict: an unknown parameter is `400 validation_failed` (its name is not
  echoed). `limit` is a plain decimal integer.
- Pagination: `limit` (1–100, default 25) and an opaque `cursor`. The response is
  `{ items, nextCursor, limit }`; `nextCursor` is `null` on the last page. Pass it back unchanged;
  never build or parse it. Pages are stable under concurrent inserts (cursor over
  `(createdAt, _id)`); there is no total count.
- Sort: `sort=-createdAt` (default, newest first) or `sort=createdAt`.
- Dates are ISO-8601 strings. Ids are prefixed (`psub_…`, `psrc_…`, `pevt_…`).
- Errors: `{ error: { code, message, details?, issues?, requestId? } }`. `message` is a fixed
  English text; show a UI label per `code`. `issues[]` (400 only) are `{ path, code, message }`
  per invalid field; they never echo the submitted value.

| Status | `code`                   | Meaning / UI                                                                   |
| ------ | ------------------------ | ------------------------------------------------------------------------------ |
| 400    | `validation_failed`      | Invalid body, query, id or `Idempotency-Key`; highlight `issues[].path`        |
| 400    | `bad_request`            | Malformed request (e.g. invalid JSON)                                          |
| 400    | `linkedin_import_only`   | LinkedIn can only be imported as the subject's export file (never fetched)     |
| 404    | `not_found`              | `details: { entity, id }`                                                      |
| 409    | `idempotency_key_reused` | The same `Idempotency-Key` was sent with a different body — generate a new key |
| 409    | `subject_archived`       | The subject is archived: read-only, no new sources                             |
| 409    | `stale_subject_revision` | The subject changed since it was loaded — reload and retry                     |
| 500    | `internal`               | Show `requestId` for support                                                   |

## GET /api/professional/subjects — list

| Query       | Values                         | Filter                                     |
| ----------- | ------------------------------ | ------------------------------------------ |
| `status`    | `active \| archived`           | exact                                      |
| `reference` | opaque token                   | exact match (find a subject by its handle) |
| `limit`     | 1–100                          | page size                                  |
| `cursor`    | from the previous `nextCursor` |                                            |
| `sort`      | `-createdAt \| createdAt`      |                                            |

Response `{ items: SubjectDoc[], nextCursor: string | null, limit }`. Columns:

| Column        | Path                                       | Notes                                                               |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| Reference     | `reference`                                | Opaque operator handle; the only human-facing identifier            |
| Status        | `status` (`active \| archived`)            | Archived subjects are read-only                                     |
| Data class    | `consent.dataClass`                        | `synthetic \| owner_consented` (no other class exists before FE-P2) |
| AI processing | `consent.aiProcessing`                     | `allowed \| denied` — AI extraction runs only when `allowed`        |
| Sources       | `sourceCount`                              | Registered sources                                                  |
| Uploads       | `acquisitionCount`                         | Accepted uploads across the subject's sources (0 when absent)       |
| Created       | `createdAt`, `createdBy.{kind,id}`         |                                                                     |
| Consent as of | `consent.recordedAt`, `consent.recordedBy` | When and by whom the current consent was recorded                   |

Also present: `_id`, `rev` (edit revision), `consent.processingBasis` (a code), `archivedAt?`,
`updatedAt`, `schemaVersion`. `createRequestHash` is internal (idempotency) — do not display. The subject's internal target ranking fence (`targetsRev`, P5.1) is never returned.

States: empty list (no subjects) → show the create action; `nextCursor` → "Load more".

## POST /api/professional/subjects — create

Headers: `Idempotency-Key` (recommended; 8–200 of `A-Z a-z 0-9 _ . : -`). Body:

```ts
{
  reference: string; // opaque token, ≤ 120
  consent: {
    dataClass: 'synthetic' | 'owner_consented';
    processingBasis: string; // lower-case code, e.g. 'consent'
    aiProcessing: 'allowed' | 'denied';
  }
}
```

Response **201** `{ subject, created: true }`; a replay with the same key and body returns **200**
`{ subject, created: false }` (the same subject). Same key, different body → 409
`idempotency_key_reused`. Without a key every call creates a new subject — the form should
generate a key once per submission. The consent record stores who recorded it and when; a
`subject.created` event is written with it.

Permission assumptions: none in v0.1 (internal operator). Subject-level access checks will be
added at `assertSubjectAccess` in the route module; the UI must handle 403/404 on any subject.
