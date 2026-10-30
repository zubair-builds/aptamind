# Market imports (contract for `/imports`)

Owner: Market (API, record, workflows). Consumer: Admin (`/imports`). Decision: DECISION_LOG
2026-10-01 "Admin Imports is part of preflight". Brief: `streams/market-ops.md`.

An **import** is one operator file pushed through the normal evidence path:
file → source snapshot → workflow run → observations → resolution → reconciliation → canonical
records and reviews. An import never writes canonical collections itself. It is a record that
points at the snapshot and run that did the work, so an operator can trace
Import → Run → Snapshot/Observations → Companies/Jobs/Sources/Reviews.

## Types

| `type`       | Source provider (upload-only)   | Workflow                          | Status                      |
| ------------ | ------------------------------- | --------------------------------- | --------------------------- |
| `companies`  | `company_directory` (M8.1)      | `market.company_directory.import` | available                   |
| `ats_boards` | `ats_board_directory` (M8.2)    | `market.ats_boards.import`        | available                   |
| `snapshot`   | any source that accepts uploads | the source's own workflow         | available (wraps M6 upload) |
| `jobs`       | reserved (OPS-5)                | reserved                          | refused for now (see below) |

## Flow (Admin)

1. The operator picks a type and a file. **The browser reads the file** (CSV, UTF-8) and shows the
   header and up to 20 sample rows. Nothing is uploaded yet.
2. The operator maps columns to fields, or drops them. A column that is not mapped is removed in
   the browser. The upload contains only mapped columns, with the header names the mapping uses.
3. Target source: an existing source of the type's provider, or a new one. A new one is created
   with `POST /api/sources` (existing endpoint, `acquisition.config.columns` = the mapping). A
   changed mapping on an existing source is saved with `PATCH /api/sources/:id`.
4. `POST /api/imports` uploads the reduced file and starts the run.
5. The import detail page shows progress and results.

## Record (`market_imports`)

```ts
{
  _id: string;                 // imp_<ulid>
  type: 'companies' | 'ats_boards' | 'snapshot' | 'jobs';
  fileName: string;            // as given by the operator; trimmed, max 255, control chars removed
  contentType: string;
  bytes: number;
  contentHash: string;         // sha256 hex of the uploaded (reduced) bytes
  artifactId: string;
  snapshotId: string;
  snapshotUnchanged: boolean;  // the same bytes were already a snapshot of this source
  sourceId: string;
  runId: string | null;        // null only if the run could not be started (see error)
  createdBy: Actor;
  createdAt: Date;
  error?: { code: string; message: string };
}
```

Status and counts are **derived at read time** from the run and its outputs, never copied, so
they cannot drift. The record itself is append-only.

## Endpoints

### `POST /api/imports?type=<type>&sourceId=<id>&fileName=<name>`

Body: the file bytes (`text/csv` for `companies` and `ats_boards`; the source's accepted type for
`snapshot`). Same size cap and streaming cut-off as `POST /api/sources/:id/snapshots`.

- Checks run **before anything is stored**, exactly as the source upload does (the M8.1 problem
  codes, `400 validation_failed` / `413 limit_exceeded`, `details.problems[]`). A refused file
  creates no import record.
- Column-level problems carry `column` (a string) and, when the column is in the header,
  `position` (its 1-based column number). `column` is the column's name when that name comes
  from the source configuration (a mapped column, a missing column, or a configured column that
  names personal data; trimmed, at most 64 characters). Header text that is not configured is
  never echoed: such a column is `column N` (privacy rule in `market-sources.md`, "The 400 body
  never echoes header text"). See "Deviations" below.
- The source must exist (`404 not_found`) and be enabled (`409 invalid_state`). Its provider
  must match the type: `400 validation_failed` with problem
  `{ code: 'wrong_source_type', expected, actual }`.
- `type=jobs` is `400 validation_failed` with problem `{ code: 'not_supported' }` until OPS-5.
  The shared error codes have no `not_supported` code, so it is a problem code instead.
- The query is strict: an unknown parameter is `400 validation_failed`.
- If the run cannot start after the snapshot is stored, the record keeps `error` and
  `runId: null`, and its status is `failed`. The response is still `201`.
- `201` returns the import detail (below), with `status: 'processing'`.
- Idempotent on bytes per source: uploading the same reduced file again creates a new import
  record (a new operator action) that points at the existing snapshot; the run is the
  workflow's normal idempotent replay.

### `GET /api/imports?type=&status=&sourceId=&cursor=&limit=`

Newest first (`createdAt`, then `_id`, descending). `limit` default 25, max 100. Keyset
pagination: pass `nextCursor` back as `cursor` (`{ items, nextCursor }`). Items are the summary
shape: the detail without `trace`. A malformed cursor is `400 validation_failed`.

`status` is derived, so a `status` filter reads records in batches and stops after 2000 records
per request. A page can then hold fewer than `limit` items with a non-null `nextCursor`. Every
page does one batched run lookup and one batched source lookup (no per-row queries). A completed
run whose output was stored as an artifact (a very large output) costs one artifact read.

### `GET /api/imports/:id`

```ts
{
  ...record,
  source: { id: string; name: string; provider: string };
  status: 'processing' | 'completed' | 'completed_with_issues' | 'failed' | 'cancelled';
  startedAt: Date | null;
  finishedAt: Date | null;
  counts: {
    rows: number | null;       // data records in the file
    parsed: number | null;     // records read without a structural error
    accepted: number | null;   // records that became observations/candidates
    created: number | null;    // canonical records created (companies; sources for ats_boards)
    updated: number | null;    // existing canonical records that changed
    unchanged: number | null;  // matched an existing record, nothing changed
    ignored: number | null;    // skipped on purpose (blank row, duplicate in file)
    failed: number | null;     // rows with an error (listed in the import report)
    reviews: number | null;    // review items opened by this import (see below)
    warnings: number | null;   // row and file warnings (a value dropped, e.g. a domain refused
                               // as shared hosting; a file with no id column)
  };
  trace: {
    runId: string | null;
    snapshotId: string;
    artifactId: string;
    reviewIds: string[];       // reviews opened by this import, at most 200
    companyIds: string[];      // canonical companies touched, at most 200
    sourceIds: string[];       // ats_boards: job sources registered or confirmed by this import;
                               // companies: none (discovery registers later, in its own runs)
    reportArtifactId: string | null; // the full import report (all row errors, warnings and
                               // row failures); set whenever warnings > 0 or failed > 0,
                               // null only when the import had none
    truncated: boolean;
  };
}
```

- `null` count = not known yet (run still processing) or not meaningful for the type. A
  `snapshot` import always has `null` counts.
- Counts and trace come from the run output `importReport` (written by the workflow's finalize
  step). For `ats_boards`, `created` is boards newly registered, `unchanged` is boards already
  registered to the same company, and `updated` is always 0. `ignored` is duplicate rows plus
  rows skipped for a `not_an_ats_url` warning. `failed` includes the row failures
  `board_not_live`, `board_unreachable` and `no_identity`. A file-level `parser_failure` review
  counts in `reviews`.
- `reviews` and `reviewIds` hold only reviews **opened by this import**: created at or after the
  run start. A row whose review an earlier import opened (and that is still open) is not
  counted again, so re-importing the same file reports `reviews: 0`.
- `completed_with_issues` = the run succeeded and `failed > 0` or `reviews > 0`.
- `404 not_found` for an unknown id.

## Known ATS board file (M8.2, OPS-1b, `ats_boards`)

`acquisition.config.columns`: `provider?`, `token?`, `company?`, `domain?`, `url?`. Map
`provider` and `token`, or `url`, or all three. Map at least one of `company` or `domain`.
`provider` values: `greenhouse`, `ashby`, `lever` (case-insensitive). Every column must be
mapped (same rule as M8.1).

**Board from a URL (OPS-1b).** When `url` is mapped, the server reads the provider and token
from a board or job link on these hosts: `boards.greenhouse.io`, `job-boards.greenhouse.io`,
`job-boards.eu.greenhouse.io`, a Greenhouse `embed/job_board?for=<token>` link,
`jobs.ashbyhq.com`, `jobs.lever.co` and `jobs.eu.lever.co`. Trailing paths (a job id) and query
strings are ignored. An EU host gives the EU board.

- A URL on any other host is a row warning `not_an_ats_url`. It never creates anything. When
  the row has no provider and token either, the row is skipped (counted in `ignored`).
- A board host without a readable token is a row error `invalid_url`.
- A trailing dot on the host (`boards.greenhouse.io.`) is ignored.
- An Ashby board name may hold single spaces. A percent-encoded token (`blackpoint%20cyber`, in
  a token cell or a URL) is read as `blackpoint cyber`. Ashby serves these boards (checked live).
  A token is never trimmed or collapsed: a leading, trailing or double space (`%20lead`,
  `dbl  sp`) is `invalid_token` (`invalid_url` in a URL). Greenhouse and Lever tokens with a
  space stay `invalid_token`.
- Provider and token cells that disagree with the URL fail the row with `url_mismatch`.
- A row with no provider, no token and no URL value fails with `missing_board`.

Board tokens are case-insensitive. Every board source key uses the lowercased token
(`greenhouse:zzshared`), whoever registers it (this import or careers discovery), so `ZZShared`
and `zzshared` in one file are one board: the first row wins and later rows are
`duplicate_row_key`, also when they give another company name or come from a URL. Source
registration matches an existing key ignoring case (index `by_key_ci`), so an older mixed-case
key is found, never duplicated. The stored `endpoint.boardToken` and the listing URL keep the
first-seen case for fetching.

Per row, in this order (DECISION_LOG "A live ATS board is company identity evidence"):

1. **The board is already a source** → its company; the row is `unchanged`. When the row's
   domain belongs to another company → an owner review (`careers_discovery`). Nothing changes.
   A board source with no company is attached to the company the next steps find or create
   (only while it still has none; audit event `source.owner_changed`).
2. **Domain match** → register the board for that company.
3. **`ats` id match** (the board key: `ats:<provider>:<lowercased token>`, or
   `ats:<provider>:eu:<lowercased token>` for an EU board; see the external-id registry in
   `market-sources.md`) → register the board for that company. An EU board and a default-host
   board with the same token are different boards and different companies.
4. **A unique exact name match and no domain** → register the board for that company.
5. **A name match that cannot attach** (several companies, or a domain that matches nobody) →
   a `company_resolution` review. Nothing is registered.
6. **No match** → one liveness fetch of the board listing, through the provider adapter and the
   shared per-host limiter. Every hop must stay on the provider's API hosts. Live means HTTP 200
   and a JSON listing that parses, even with 0 jobs. (All three providers answer 404 for an
   unknown board, checked live, so an empty listing is a real board with no open jobs.)
   - Live → the board source is registered first, owned by the company id `hash(board key)`,
     with no schedule. It gets its refresh schedule (every 6 hours) only once its company exists.
     A claim given back after a clash stays unscheduled until a later row or a reviewer attaches
     it.
     Then that company is created: name from the row (else its domain), the `ats` id,
     authority `third_party`. The company and its audit event `company.created_from_ats_board`
     (row, board, listing artifact) are written in one transaction. Its observation points at
     the file row, and the listing becomes the board's first snapshot. When another process
     registered the board meanwhile, the row decides again (step 1); nothing is created.
   - 404, 410, or JSON that is not a listing → row failure `board_not_live`.
   - Timeout, 5xx, 429, a 200 that is not JSON (an HTML error page), a redirect off the API
     hosts, or another status (retried once) → row failure `board_unreachable`. Importing the
     file again retries it.
   - In both failure cases nothing is recorded or created and no review opens.

Known counting gap: when a run crashes after creating the company but before linking the row,
the import that finishes the row counts it as `unchanged`, not `created` (and not in
`companiesCreated`). The company, board and audit event are still correct.

A row with no company name and no domain whose board has no company yet fails with
`no_identity`. A board file never gives official authority: its source must be `third_party`
(400 on create or patch otherwise), and its rows count as `third_party` evidence whatever tier
an older source holds. A company is never created from a bare name without a live board. Re-importing
the same file creates nothing and opens no review. A row whose review was later merged registers
on the next import of the file.

The import report (`ats_board_import_report`) holds `errors`, `warnings` (with `skipped`) and
`rowFailures` (`{ line, code, reason }`; `reason` is a fixed text or an HTTP status, never cell
or response text). Map errors and thrown row failures raise the file `parser_failure` review;
decided row failures do not.

Throughput: rows run 8 at a time. The per-host limiter (2 requests at a time, 250 ms apart by
default) bounds each provider host, so a file of about 1,000 boards on one host takes several
minutes. A row body has a 3-minute timeout.

**Admin change needed (OPS-1b).** `apps/admin/lib/import-mapping.ts` still marks `provider` and
`token` as required for `ats_boards`. It must accept a mapping with `url` instead (the API
refuses a mapping with neither). The import detail should show the new row warning
`not_an_ats_url` and row failure codes `board_not_live`, `board_unreachable`, `no_identity`
and `url_mismatch` from the report.

The provider, reader and per-row rules are in `market-sources.md` ("Known ATS board file
(M8.2)").

## Discovery after a company import

When a company import run finishes, careers discovery is queued for the companies it created
or changed that have a domain and no recent discovery attempt. Discovery also runs on a schedule
for companies never tried or last tried more than 30 days ago (bounded batch).

- The import workflow's `discover` step starts `market.careers_discovery.batch` runs of at most
  100 companies each, with idempotency key `careers_discovery:import:<runId>:<chunk>`. One
  import queues at most 1000 companies. The schedule picks up the rest.
- The `system:careers-discovery` source runs `market.careers_discovery.batch` every 60 minutes
  (UTC), 25 companies per run. Boot seeds this schedule once and then sets the source label
  `system-schedule-seeded`. A later boot never puts back a schedule that an operator removed.
- A discovery that fails (any thrown error) still records the attempt:
  `careersDiscoveryStatus: 'failed'` and `careersCheckedAt` = now (`market.discover_careers@2`).
  So the hourly batch moves on to other companies.
- "Due" means: active, has a domain, and `freshness.careersCheckedAt` is missing or older than
  30 days. Index `by_careers_due_with_domain` serves the scheduled selection.

## Source health additions (used by `/imports` and `/sources`)

`GET /api/sources` list items and `source` in `GET /api/sources/:id` carry:

```ts
schedule: {
  cron?: string;
  intervalMinutes?: number;
  timezone: string;
  enabled: boolean;         // source enabled, schedule configured and scheduler entry enabled
  nextRunAt: Date | null;   // the scheduler's nextFireAt, or backoffUntil when that is later;
                            // null when not enabled
  lastFiredAt: Date | null;
  backoffUntil: Date | null; // OPS-2: health.backoffUntil; null when no backoff was set
} | null;                   // null for upload-only sources, sources with no schedule and
                            // sources with no scheduler entry
```

During a source backoff, scheduled fires before `backoffUntil` are deferred without a request.
`nextRunAt` therefore never shows such a fire: it is the earliest time the next fetch can run. The
fetch itself happens at the first scheduled fire at or after `backoffUntil`.

The list reads all scheduler entries of a page in one query. The detail response keeps its
existing top-level `schedule` (the raw scheduler entry) for compatibility.

## Known limits

- A `status` filter on `GET /api/imports` reads at most 2000 records per request (status is
  derived at read time). A page can hold fewer than `limit` items with a non-null `nextCursor`.

## Deviations

- Column names in `details.problems[]`. The OPS-1 repair asked that every column-level problem
  name the column by its header name. That conflicts with the privacy rule in
  `market-sources.md` (unmapped and personal-data header text is never echoed; tested by the
  M8.1 refusal tests). This contract names a column only when the name comes from the source
  configuration, and adds `position` for every column in the header. Changing the privacy rule
  needs an owner decision.
