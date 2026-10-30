# Contract: Market sources (list, detail, create/update, run, snapshots)

Owner: Market. Consumer: Admin UX (sources list, source record, new-source form). Status: **v2.5
(OPS-1)** = v1 (`d9799b6`) + strict query validation and DTOs (M7.1) + list v2, server-computed
freshness and paginated runs/snapshots (M7.4) + name word-prefix search + sponsor register
adapters (M8.4) + the H-1B history register (M11.5) + the company directory provider (M8.1) + the known ATS board file and source
schedule state (OPS-1).

Changelog: **v2.6 (OPS-1b)**: a known board file may give boards as URLs, and a live board
creates a board-anchored company (see the changelog at the end). **v2.5 (OPS-1)**: provider `ats_board_directory` (M8.2) and `schedule` state on
source rows (see the changelog at the end). **v2.4 (M8.1)** — provider `company_directory` (operator CSV upload, upload-only;
see [Company directory CSV](#company-directory-csv-m81-provider-company_directory) and the M8.1
changelog at the end). **v2.3 (M11.5)** — provider `us_uscis_h1b_employer_data_hub` (USCIS H-1B Employer
Data Hub, hiring history, attach-only). **v2.2 (M8.4)** — sponsor registers are adapters: `market.sponsor_register.import`,
provider `nl_ind_recognised_sponsors` (IND, Netherlands); see [Sponsor registers](#sponsor-registers-register-adapters-m84).
**v2.1** — `q` matches word prefixes of the name (`nameTokens`, any order; the v2
whole-name prefix still matches during the migration); `freshness=never_succeeded` leaves out
`system:*` sources. **v2** — M7.4. Conventions: [market-provenance](market-provenance.md). Code:
`apps/admin/lib/api-server/routes/sources.ts`, `packages/market/src/sources/source.service.ts`, schema
`sourceDocSchema` in `packages/market/src/sources/source.schema.ts`.

A **Source** is a durable definition of an information origin: provider, endpoint, acquisition
workflow and config, schedule, freshness class, authority, governance and health. It is not a URL.

## GET /api/sources — list (v2, M7.4)

List v2 conventions: [market-provenance § List v2](market-provenance.md#list-v2-conventions-m72m75)
(there is no `view=summary`: source rows are small). Code: `packages/market/src/api/sources.ts`
(`sourceListQuerySchema`, `listSources`), freshness in
`packages/market/src/freshness/source-freshness.ts`.

| Query                               | Values                                                                                                                                 | Filter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit`, `offset`, `after`, `count` | see conventions                                                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sort`                              | `category` (default: category, then name), `name`, `lastSuccessAt`, `createdAt`; `-` = desc                                            | `_id` tiebreak. `lastSuccessAt` = `health.lastSuccessAt` (never-succeeded sources sort first ascending, last descending).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `q`                                 | string (1–200)                                                                                                                         | **Anchored** (M7.4): **every word** of `q` is a prefix of some word of the name (tokenised like job titles: lower-case, accents removed, split on punctuation; any order — `home office` finds "UK Home Office Sponsor Register"; `by_name_tokens`), **or** (the previous release's rule, kept during the migration) the whole normalised name starts with `q`, **or** the key starts with `q` (lower-cased), or the part after its `<provider>:`/`system:` prefix does (`acme` finds `greenhouse:acme`), **or** the source's company matches `q` as a name/alias/domain prefix. **Breaking vs v1:** v1 matched case-insensitive substrings of name or key; text inside a word no longer matches. |
| `category`                          | list of `company_universe \| job_source \| signal_source \| manual_import`                                                             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `provider`                          | provider key list (`greenhouse`, `lever`, `ashby`, `careers_page`, `uk_home_office_sponsor_register`, `nl_ind_recognised_sponsors`, …) |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `enabled`                           | `true \| false`                                                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `health`                            | list of `never_run \| healthy \| degraded \| failing`                                                                                  | `health.status`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `freshness`                         | list of `fresh \| due \| overdue \| never_succeeded \| disabled`                                                                       | `freshnessState` (below), evaluated server-side on an index. The v1 notion "overdue" (dashboard) is `freshness=overdue,never_succeeded`. `never_succeeded` leaves out the built-in `system:*` sources (never scheduled; their rows still report `never_succeeded`).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `companyId`                         | id list                                                                                                                                | job boards and careers pages of these companies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `system`                            | `true \| false`                                                                                                                        | only / no built-in `system:*` sources (`system:operator`, `system:careers-discovery`). Absent = both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Response `ListPage<SourceListItem>` (DTO `sourceListV2ResponseDto`; v1 readers of
`items/total/limit/offset` are unaffected): the full `SourceDoc` plus

```ts
freshnessState: 'fresh' | 'due' | 'overdue' | 'never_succeeded' | 'disabled';
freshnessAgeMs: number | null; // now − health.lastSuccessAt; null when it never succeeded
companyName: string | null; // the company's displayName, when companyId is set
schedule: {                 // OPS-1: scheduler state (workflow_schedules), one query per page
  cron?: string;
  intervalMinutes?: number;
  timezone: string;
  enabled: boolean;         // source enabled, schedule configured, scheduler entry enabled
  nextRunAt: Date | null;   // the entry's nextFireAt, or backoffUntil when later; null when not enabled
  lastFiredAt: Date | null;
  backoffUntil: Date | null; // OPS-2 source backoff (see market-imports.md); null when none
} | null;                   // null for upload-only sources and sources with no schedule
```

`schedule` replaces the stored schedule config on list rows and on `source` in the detail. It
keeps the config fields, so a reader of `schedule.cron` or `schedule.intervalMinutes` still
works.

**Freshness (M7.4, server-computed; the UI must not classify it):**

| State             | Condition                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `disabled`        | `enabled: false`                                                                                                                                                                                             |
| `never_succeeded` | enabled, no `health.lastSuccessAt`                                                                                                                                                                           |
| `overdue`         | enabled, age > `freshness.maxAgeMinutes`                                                                                                                                                                     |
| `due`             | enabled, age > the refresh interval of its `freshness.policyClass` (`freshness/policies.ts`, e.g. ATS listings 6 h) and not overdue. Only when the class is known and refreshes sooner than `maxAgeMinutes`. |
| `fresh`           | enabled, neither due nor overdue                                                                                                                                                                             |

Age is processing time since the last successful run. Boundaries are strict (exactly
`maxAgeMinutes` old is not overdue). The dashboard's `freshness.overdueSources` now uses the same
indexed query (`overdue` + `never_succeeded`, system sources excluded).

Columns: name, `key`, `category`, `provider` (open string), `enabled`, `authority.tier`,
`health.status` with `consecutiveFailures`, `health.lastSuccessAt`, `health.lastFailureAt`,
`health.lastError`, `health.lastItemCount`, `schedule` (`intervalMinutes` or `cron`),
`freshness.maxAgeMinutes`, `freshnessState`, `stats {attempts, successes, failures}` (logical
runs), `companyName` → `/companies/:companyId`. De-emphasise `system:` keys (or send
`system=false`).

- **Health semantics**: `degraded` after 1 failed logical run, `failing` after 3 consecutive.
  Counters count each workflow run at most once per outcome, even across retries and replays.

Indexes: `list_category_name`, `list_name`, `list_last_success`, `list_created` (sorts),
`by_freshness` (freshness), `by_provider`, `uniq_key` (anchored key search).

## GET /api/sources/:id/runs — run history (M7.4)

`limit` (1–200, default 50), `offset`, `state` (run state: `PENDING | RUNNING | WAITING |
CANCELLING | COMPLETED | FAILED | CANCELLED`), `workflowKey`. Response `Page<RunSummary>` (DTO
`sourceRunsResponseDto`): top-level runs labelled with the source (manual, scheduled, review
retries), newest `createdAt` first, without `input`/`output`. Offset pagination only (the runs
belong to the runtime's collection). 404 for an unknown source.

## GET /api/sources/:id/snapshots — snapshots (M7.4)

List v2 paging (`limit`, `after`, `offset`, `count`), `sort=-lastFetchedAt` (default) or
`lastFetchedAt`. Response `ListPage<SnapshotDoc>` (DTO `sourceSnapshotsResponseDto`), keyset
cursor on `by_source_recent`. An unchanged re-fetch moves a snapshot's `lastFetchedAt`: a
snapshot re-fetched while you page jumps ahead of the cursor, so the remaining pages skip it
(restart from the first page to see it again). 404 for an unknown source.

## GET /api/sources/:id — detail

DTO `sourceDetailResponseDto`:

```ts
{
  source: SourceListItem;        // SourceDoc + freshnessState, freshnessAgeMs, companyName (M7.4), schedule state (OPS-1)
  runs: WorkflowRunDoc[];        // top-level runs labelled sourceId (manual + scheduled), newest first, ≤20, no input/output
  snapshots: SnapshotDoc[];      // newest lastFetchedAt, ≤10  (packages/market/src/observations/schemas.ts)
  schedule: ScheduleDoc | null;  // runtime schedule owned by this source (workflow_schedules); a source
                                 // without a schedule has a disabled placeholder (enabled: false);
                                 // an upload-only source (company_directory) has none: null
  openReviews: ReviewItemDoc[];  // open items whose entity or candidate is this source, ≤20
  audit: AuditEventDoc[];        // ≤20
}
```

- Snapshot: `{ _id, sourceId, artifact{artifactId, sha256, size, mimeType…}, contentHash, url,
httpStatus, contentType, firstFetchedAt, lastFetchedAt, fetchCount, runIds[], via:
http|browser|upload|crawl, itemCount }`. Snapshots are content-addressed: an unchanged
  re-fetch bumps `lastFetchedAt` and `fetchCount` and creates no new snapshot.
- `governance { accessMethod, termsNotes, commercialUseNotes, retentionRestrictions,
redistributionRestrictions, crawlPolicy, rateLimitPerMinute, lastComplianceReviewAt }`. Show it
  on the record; it is legal-relevant.
- `authority { tier, authoritativeFor[], listingIsComplete }`. `listingIsComplete: true` means
  absence from a successful listing is meaningful (it can close jobs). Show this prominently.
- Health internals (`lastCompleteImportStartedAt`, `lastListingAppliedAt`) are **source-time
  watermarks**. They are not processing times. Label them "data as of".
- `health.listingBaseline {count, snapshotId, at}` (job sources, M6.2) is the size of the last
  listing whose absences were applied. The shrink guard compares each new listing with the
  effective baseline, max(this count, open jobs present on the source). A
  listing below half the baseline with at least 10 fewer entries is held; so is an empty listing
  after a board of ≥ 10. A held listing applies no absences and raises a `source_anomaly` review.
  The baseline does not move until a listing is applied. Show the baseline next to
  `lastItemCount` ("closing compares against N jobs"). A `PATCH` that changes `endpoint` (URL or
  board token) keeps the baseline but sets `listingBaseline.endpointChangedAt`. A collapse on the
  new endpoint is then held, and its review says the endpoint changed (context
  `baselineEndpointChangedAt`). The flag disappears with the next applied listing.
  `authority.listingIsComplete` cannot be patched.
- `health.listingHeld {reason, since, lastAt, count, baseline, reviewId?}` (PR #11) is present
  while the source's listings are held. A held listing is a successful fetch (health stays
  `healthy`), not a failure. `reason: shrink` is a collapse against a baseline of ≥ 10, with a
  `source_anomaly` review (`reviewId`). `reason: small_board_empty` is a small board (baseline
  < 10) that emptied: held for one run without a review, released by the next empty listing
  (ruling L2). `since`/`lastAt` are the source times of the first and latest held listing,
  `count` the latest held size. Show a "listing held" badge, linking to the review when there is
  one. **`reviewId` may point at a review that is no longer open** (an operator dismissed or
  retried it while the board stayed small); show the review's status. The field is cleared when
  a listing is applied. `lastItemCount` is the latest listing's size, held or not.

Errors: 404 for an unknown id. The embedded `runs` (≤ 20) and `snapshots` (≤ 10) are the first
pages; page further with `/runs` and `/snapshots` (M7.4).

**Parse warnings (M6.1).** A job-board run's `fetch` node (`market.fetch_job_board@2`) output
carries `warnings[]` (≤ 50) and `skipped[] {externalId | null, kind: malformed | unlisted,
locator, reason}` — entries on the board that were not mapped (all of them when the listing is
complete; at most 200, unlisted first, when it is not). Skipped entries are never treated as
absent (their jobs keep their state), and each listing moves their copies' last sighting forward
(not a verification: ruling U1). Malformed entries raise a `parser_failure` review (severity low)
per source, adapter version and malformed set (see [market-review](market-review.md)).
`complete: false` in the fetch output means the listing closes nothing: more than 10 % of the
listed + malformed entries are malformed, a malformed entry has no id, or the provider reported a
truncation.

## Mutations

| Action           | Request                                                                   | Response                                                                                                                                         | Errors / notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create           | `POST /api/sources`, body `createSourceInputSchema` (`source.service.ts`) | 201 `{ source, created: true }` or **200** `{ source, created: false }`                                                                          | Idempotent on `key`: an existing key returns the existing source **unchanged** (the body is ignored), so tell the user "already exists". 400 with zod `issues`. Never put secrets in `acquisition.config`; use `credentialRefs` (env names). 400 when an inherently third-party provider (`aggregator`) is given an authoritative tier (`official_ats`, `official_site`, `operator`). `provider` is trimmed and lower-cased; a `job_source` provider must be one of `greenhouse`, `ashby`, `lever`, `careers_page`, `aggregator`, `manual` (400 otherwise). |
| Update           | `PATCH /api/sources/:id`, body `updateSourceInputSchema`                  | 200 `{ source }`                                                                                                                                 | `schedule: null` removes the schedule; a disabled placeholder is kept so a stale schedule never fires. `governance` is shallow-merged into the existing value. The whole document is validated before the write (400 on an invalid result). Changes are audited (`source.updated`) and re-sync the schedule.                                                                                                                                                                                                                                                |
| Enable / disable | `POST /api/sources/:id/enable` / `disable`                                | 200 `{ source }`                                                                                                                                 | Disable also disables its schedule. Idempotent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Run now          | `POST /api/sources/:id/run`, body `{ snapshotId? }`                       | 202 `{ runId }`                                                                                                                                  | 409 `invalid_state` if disabled; 503 `unavailable` if no launcher. With `snapshotId` it reprocesses that snapshot (no fetch).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Upload snapshot  | `POST /api/sources/:id/snapshots?process=true\                            | false`; raw body with content type `text/csv`, `text/plain`, `application/json`, `application/x-ndjson`, `application/octet-stream`, …; ≤ 200 MB | 201 `{ snapshotId, artifactId, unchanged, warnings[], runId \                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | null }` | Offline import path. `unchanged: true` means identical bytes already exist. `process=true` starts a run immediately. `warnings[]`: import-wide notes (directory: no identity column → every row goes to review; no id column). |
| Snapshot         | `GET /api/snapshots/:id`                                                  | 200 `SnapshotDoc`                                                                                                                                | 404                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Reprocess        | `POST /api/snapshots/:id/reprocess`                                       | 202 `{ runId }`                                                                                                                                  | Safe: reprocessing an older snapshot never counts as a new absence and never delists newer register entries.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

New-source form: the productised templates today are the UK sponsor register
(`market.uk_sponsor_register.import`), the other public sponsor registers
(`market.sponsor_register.import`, one `provider` per register adapter, [below](#sponsor-registers-register-adapters-m84)), ATS boards (`market.ats.refresh`, `provider` greenhouse,
lever or ashby, `endpoint.boardToken`) and careers pages (`market.careers_page.crawl`,
`acquisition.config.startUrl`). An EU-hosted Greenhouse or Lever board needs
`endpoint.url` = its EU listing URL (key convention `provider:eu:token`, M6.3). An ATS source
created with only `endpoint.boardToken` gets `endpoint.url` = the default-host (US) listing URL,
stored on the source, so fetch and verification always use the same host (PR #11 E1). A `PATCH`
that sends only a new `boardToken` keeps the source's current API host, so an EU board stays on
the EU host. If the current URL does not identify the host, the PATCH is a 400
(`validation_failed`, send `endpoint.url`); it never falls back to the default host (LOW-1). ATS and careers-page sources are normally created by careers
discovery, not by hand. A known list of boards can be imported as a file (M8.2, provider
`ats_board_directory`, [below](#known-ats-board-file-m82-provider-ats_board_directory)).

### Company directory CSV (M8.1, provider `company_directory`)

An operator-supplied CSV of companies, imported by `market.company_directory.import`. Code:
`packages/market/src/sources/providers/company-directory.ts`.

- **Register:** `category: company_universe`, `provider: company_directory`,
  `acquisition.workflowKey: market.company_directory.import` (the only workflow; any other is 400),
  `governance.accessMethod: manual_upload`. **Authority (ruling):** `authority.tier` defaults to
  `third_party` (omit it); `operator` and `inferred` are refused (400: a bulk upload must never tie
  with a human decision), and `official_registry` is refused for now (register exports are the
  register providers, M8.4). It is the evidence authority of every row. **Upload-only:** no
  `endpoint.url` and no `schedule` (400 `validation_failed`); a run needs an uploaded `snapshotId`
  (`POST /api/sources/:id/run` without one, or `POST /api/workflows/<key>/runs` with another
  workflow or no snapshot for a directory `sourceId`, is a 400), and every fetching capability
  refuses the source, so every file passes the checks below. An upload-only source has **no
  schedule document at all** (not even the disabled placeholder other sources get): schedule sync
  skips it, so the source detail shows `schedule: null` and there is nothing to enable (a source's
  provider cannot change, and upload-only sources never had a schedule).
- **`acquisition.config`** (strict: unknown keys are 400; validated on register and `PATCH`; the
  parsed value, defaults applied, is what the source stores):
  `columns: { name (required), legalName?, domain?, website?, country?, town?, careersUrl?, id?,
registerIds?: { <namespace>: <column> } }` — CSV header names per company field. Header names
  match **exactly** (case-, space- and accent-sensitive after trimming the cell; `Domain` ≠
  `domain`). `registerIds` namespaces come from the **Market external-id registry**
  (`packages/market/src/companies/external-ids.ts`; ruling): `gb_companies_house`, `ie_cro`,
  `lei`, `duns`, `fr_siren`, `nl_kvk`, `us_ein`, `wikidata`; any other namespace (including
  another provider's, `uk_sponsor_register`, and `ats`, which only a live board sets) is 400. There is **no `ignoreColumns`** (removed,
  ruling f89df42; the key is refused as unknown): **every column of an accepted file must be
  mapped**, so every cell passes the value policy and the header guard is defence in depth.
  `defaultCountry?` (ISO 3166-1 alpha-2, validated, stored upper-case, `UK` →
  `GB`; it fills **only an empty or absent country cell** — a dropped country, `Germnay`,
  `America`, `Global`, stays unknown: no HQ seed, no country in the record key; ruling c1a3500); `maxBytes` (default 10 MB, ≤ 50 MB); `maxRows` (default 50 000, ≤ 200 000).
- **Upload** (`POST /api/sources/:id/snapshots?process=true`, `text/csv`, UTF-8) is checked
  **before anything is stored**. Problem codes (`details.problems[]` `{ code, column?, message }`,
  at most 50, and `details.counts` `{ <code>: n }`) and their HTTP status (413 when any
  problem is a size problem, else 400):

  | Problem code           | Status                  | Meaning                                                                                                       |
  | ---------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
  | `too_large`            | 413 `limit_exceeded`    | more bytes than `maxBytes`. A body over `maxBytes` is cut off while streaming (413, not audited: never read). |
  | `too_many_rows`        | 413 `limit_exceeded`    | more data records than `maxRows` (records, not lines)                                                         |
  | `not_csv`              | 400 `validation_failed` | content type is not `text/csv`, `text/plain`, `application/csv` or `application/vnd.ms-excel`                 |
  | `not_utf8`             | 400 `validation_failed` | the bytes are not valid UTF-8 (fatal decoding; export as "CSV UTF-8")                                         |
  | `no_header`            | 400 `validation_failed` | no header row                                                                                                 |
  | `malformed_header`     | 400 `validation_failed` | the header row itself is malformed CSV (a stray quote, > 1000 columns)                                        |
  | `missing_column`       | 400 `validation_failed` | a mapped column is not in the header                                                                          |
  | `duplicate_column`     | 400 `validation_failed` | a header name appears twice                                                                                   |
  | `unmapped_column`      | 400 `validation_failed` | a header column is not mapped (every column must be; remove it from the file)                                 |
  | `personal_data_column` | 400 `validation_failed` | a header column names personal data (below)                                                                   |

  **The 400 body never echoes header text that is not a configured column name:** unmapped and
  personal-data columns are named by position only (`column 3`); a duplicate is named when it is
  a mapped or ignored column, else by position; a missing column is a configured name.

  **Personal-data guard** (code: `sources/providers/directory-headers.ts`): a header name is
  normalised first — zero-width characters stripped, accent-folded, split on camelCase and
  letter/digit boundaries and on punctuation, lower-cased — into tokens (`Tel1` → tel, 1;
  `Téléphone` → telephone) and their joined letters (`phonenumber`). It is refused when:
  - the joined letters contain a strong substring: email, phone, mobile, birth, passport,
    linkedin, nationalinsurance, whatsapp, wechat, snapchat, skype, instagram, facebook, twitter,
    username, iban, bankaccount, sortcode, courriel, correo, geburtsdatum, vorname, nachname,
    voornaam, achternaam, cognome, apellido, nazwisko, contatto, telefon, telno, mobno, contactno,
    contactnumber, contactperson, keycontact, ownername, directorname, kontakt, ansprechpartner,
    geschäftsführer, residential/home address, first/last/full name, surname, ethnicity, religion,
    salutation, decisionmaker, soletrader, hiring/talent lead, hiring manager, … — so
    `PhoneNumber`, `phonenumber` and `PHONENUMBER` are all refused;
  - a token is a people-role or personal word (contact, person, owner, proprietor, inhaber,
    founder, director, dirigeant, gérant, manager, partner, secretary, officer, chair,
    president, recruiter, principal, handy, portable, móvil, gender, …) or the joined letters
    start or end with one (`OwnerName`, `Chairman`);
  - a short token (tel, tlf, mob, cell, fax, mail, utr, ceo, dob, ssn, nino, age, sex, md, ni, ph,
    attn, fao, insta) is a whole token, or starts the joined letters with nothing, a number/name
    suffix (no, nr, num, number, nummer, ephone, efon, name, id, address) or digits after it
    (`TelNo`, `Tel1`, `Faxnummer`) — never as a suffix or with other text (`Hotel`, `Telecoms`,
    `Percentage`, `Mailing address` are allowed);
  - two tokens form a pair (contact name/person, key contact, care of, head of, decision maker,
    sole trader, ni number, ph no, …) or spell d-o-b (`D.O.B`).

  **Allowed:** headcount columns (`Employees`, `Employee count`, `Employee range`, `Employees
(UK)`, `Number of employees (2023)`, `Headcount`, `Headcount growth`); counts of people in a
  role (`Number of directors`, `Director count`, `Number of Founders`, `Number of Associated
Contacts`); `Postcode`; `Mailing address` and `Contact page` (exact headers only — `Contact`,
  `Contact name`, `Contact person` stay refused); and legitimate headers that would otherwise
  match: the Companies House BasicCompanyData row (`LimitedPartnerships.NumGenPartners`,
  `NumLimPartners` — the full header row is a test vector; its `RegAddress.CareOf` is refused: a
  "care of" name is a person), `NI Company Number`, `Email domain`, `Mobile app`, `Automobile
sector`, `Ownership`, `Partnership`, `Principal office city`, `Company LinkedIn URL`, `Owner company`
  (`Partner name`, `Applicant name` stay refused). **Company switchboard numbers ("Company phone", "Company
  Telephone") are refused too**: the import reads no phone field and a phone column cannot be told
  apart from a person's number — remove it before uploading. A header cell that itself holds a
  contact value (a file without a header row) is refused as `personal_data_column`.
  The column map can never admit a personal-data column (400 at configuration time). The refusal is audited (`source.snapshot_upload_refused`) with the problem codes and
  counts only — never a column name or any other text of the file.

- **Reader:** strict RFC 4180 (comma, `"` quoting with `""` escapes, a UTF-8 BOM is skipped).
  CRLF, LF and a **lone CR** each end a record; blank lines are skipped. A quote inside an
  unquoted field (`a"b`, ` "x"`), text after a closing quote, an unterminated quote or a wrong
  field count makes the record a `malformed_row` (never imported with shifted columns). Row
  numbers are physical file lines (the header is line 1) — what a spreadsheet shows.
- **Rows:** each valid row becomes a company observation with provenance (`snapshotId`,
  `artifactId`, `locator: row:<line>`, parser `company-directory-row@1`), then resolution
  (review on ambiguity: `company_resolution`) and reconciliation. `town` maps to the head-office
  location (`locations[{ city, country, kind: 'hq' }]`). Register ids are stored normalised to
  their namespace format (`445790` → `gb_companies_house:00445790`; Companies House also accepts
  the published two-letter prefixes SC, NI, OC, SO, NC, LP, SL, SE, FC, GE, … + 6 digits and the
  old Northern Ireland `R0` + 6 digits).
  **Identity is structural** (DECISION_LOG "Company directory identity is structural"; ruling
  d819f87): a host denylist can never be complete, so
  - _only the mapped Domain column is domain identity evidence._ The Website is stored as a
    scheme + host attribute (`https://www.acme.co.uk/about?x=1` → `https://www.acme.co.uk/`); it
    never becomes `identity.domain`, a `domain:` identity key or a record key, and never makes a
    name less bare — for resolution and for reconciliation alike (the reconciler never falls back
    from `payload.domain` to `payload.website` for a directory row). The careers URL is never a
    domain source.
  - _A directory row auto-matches only without contradicting evidence_ (DECISION_LOG "Directory
    rows auto-match only without contradicting evidence", ruling ba9e150). Whatever found the
    company (external id, domain, exact or brand name), the match is refused and becomes a
    `company_resolution` review unless (a) the row's own v2 strict or loose key — from its name
    **or its legal name** — equals one of the company's own keys (computed from its display and
    legal names, never merely held in `identityKeys`; a token overlap is not enough); (b) no
    single-valued register namespace (every Market registry namespace: one company has one
    company number, one LEI, …) holds a different id on the company — that is a
    **high-severity** review (also when another step raised the review, e.g. a fuzzy review seen
    during a creation race); (c) countries agree or one is unknown; (d) the hit is not alias-only;
    and (e, ruling f89df42) a row whose register ids found nothing does not attach by name or
    domain to a company that holds register ids only in other registers (low review). A
    loose-only (brand) key match additionally needs no town contradiction with the company's
    registered towns. **Contradicting ids:** two different ids in one registry namespace
    contradict (one company number, one LEI, …), except: `duns` never contradicts (one D-U-N-S
    number per site), and Companies House `BR` numbers (UK establishments of an overseas company)
    coexist only with other `BR` numbers and with one `FC` number — a `BR` number beside any other
    company number (`BR001234` vs `04811111`) is a contradiction (ruling b24e5dd), as are two `FC`
    numbers or two ordinary numbers.
  - _Concurrency_: a company created from a candidate holds the candidate's register ids
    (`identity.externalIds`) and HQ country (a low-confidence `geography.headquarters` fact) in
    the creating write, next to its identity keys, so a concurrent import — and a lost creation
    race's retry — sees them at once. The HQ country seeded this way is only an HQ or
    registered-office country (never `locations[0]` or a licence country). `ext:` identity keys
    are always read back as ids too (backstop, whether or not the company was reconciled; ruling
    c1a3500). Reconciliation **releases a stale `ext:` identity key only inside its
    revision-guarded commit** (the same `updateOne` that writes the derived fields; a release
    planned from an older observation set never lands), and only a key that a **superseded observation of this
    company** (an older version of a source record) carried, that no current observation of the
    company carries, and that the current version of that same source record (still in flight, or
    resolved to this company) does not carry. (A rejected observation keeps no company link, so it
    never counts.) A key seeded at creation whose observation has not linked yet, and any key
    carried by a current observation, is never released. **Linking an observation to a company**
    (pipeline create and match, operator merge-to-target — every `resolved` resolution with a
    company) **and superseding a version linked to a company advance that company's revision**
    **in the same MongoDB transaction** as the write (ruling 621f14c; the bump runs first, so the
    company document is write-locked until the transaction ends), so a release planned before the
    link or the newer version — even one whose commit is issued while the link transaction is
    open — fails its revision check and recomputes. So correcting an id by
    re-import leaves no stale id or key behind, and a reconcile between a creation and its link,
    a link between a plan and its commit, or a stale release racing a newer observation removes
    nothing it should keep. A **pipeline link also claims the observation's register-id keys** in
    the same transaction (every `ext:` key of an id that contradicts none of the company's ids):
    if another company took such a key meanwhile, the duplicate-key error aborts the link and
    the observation re-resolves (it is never linked without the key, so no other row can create a
    second holder in between; re-verification #9). An observation id that **contradicts** a
    single-valued id the company holds, as read inside the link transaction (`idsContradict`: a
    concurrent row linked first with another company number), throws `ContradictingIdError`: the
    transaction aborts, nothing is linked, and the observation re-resolves to a **high-severity
    review** — never a union of two company numbers (ruling af1b342; an id the company already
    holds is the matched evidence and never contradicts; a contradiction on the last resolve
    attempt still ends in its review, never in a "did not converge" error). The link target is resolved inside the
    transaction — a company merged meanwhile is followed to its survivor (a merge loop is an
    `InvalidStateError`, a broken chain `NotFound`) — and only active
    companies are bumped; the operator merge-to-target is resolved in the review transaction.
    **Cost** (re-verification #9, measured on a 2 000-row import on the single-worker harness):
    about 13–40 % slower than without the transactions (≈10 ms → 11–15 ms per row; ≈8–9 min →
    9–12.5 min for 50 000 rows); an unchanged re-import is unaffected. **Map throughput**
    (re-verification #12, the plan node alone, 10 mapped cells): ≈0.43–0.46 ms per realistic row —
    50 000 rows (14.5 MB) in ≈21 s, 200 000 rows (59 MB) in ≈93 s — and ≈23 ms per adversarial row
    of ~2 000-character cells (≈115 s for 50 MB). The map runs in batches (1 000 rows or 250 ms)
    and between them yields the event loop and heartbeats its lease (the longest gap measured on
    200 000 rows: ≈0.5 s), so a long pass never loses its 60 s lease or blocks the worker. A stale key is released only when **that** company is next
    reconciled: when a record's newer version resolves to another company, or stays in review,
    the older holder keeps the key until something reconciles it (it is still the key's rightful
    older holder; follow-up in the stream file).
    Two imports of one name with two company numbers give one company plus a high review, or two
    companies — never a union; a concurrent import with another country is a review, never a
    silent HQ change.
  - _Rows in one file with the same name key and country but contradicting ids in one namespace_
    (`idsContradict`: several BR numbers beside an FC number, or several D-U-N-S numbers, do not
    contradict) all go to a high-severity review (never an automatic create or match; not a row error).
  - _One external id on rows with different names in one file_ makes all of those rows
    `conflicting_external_id` errors (none is imported); the same name twice is a
    `duplicate_row_key`.
  - _Reconciliation (every source, `company-policy/2`)_: two different ids in one single-valued
    register namespace on one company are a recorded conflict, never a silent union: both stay in
    `identity.externalIds`, `quality.conflictFields` gets `identity.externalIds`, a high-severity
    `field_conflict` review is raised (`field_conflict:company:<id>:externalIds:<namespace>`,
    `context.values` = every id), and the second id gets no identity key. The review is refreshed
    on every reconciliation (values and evidence follow), resolves itself once the namespace
    holds one id again, and a **dismissal holds for its set of ids and every subset of it**: a new id
    re-raises it, and whenever the current set is within ANY dismissed set the open item is
    resolved (dismiss {1,2}, a third id re-opens it, rejecting the third closes it; dismiss
    {1,2,3}, then {1,2} raises nothing). Its only action is `dismiss`. The review text says:
    dismiss if every id belongs to this company; otherwise dismiss, or **re-import with an id
    column** (the corrected row replaces the old record). Register ids cannot be corrected or
    split in the app in v0.1, and there is no action to reject an already-resolved observation.
  - _A name-key hit counts only when the key is the matched company's own v2 key_ (any candidate:
    exact and loose steps). A hit on a key the company merely holds — a legacy name-norm/1 key:
    "µTech Ltd" keyed `name:tech ltd` under v1 — is a legacy match (`name_legacy_key`): a review,
    never an auto-match. A genuine "Tech Ltd" is still creatable from that review: `create_new`
    gives it a qualified key (`name:tech ltd#gb`, qualifier = town, else country, else review id),
    so the unique identity-key index does not clash with the legacy key.

  **Value policy** (defence in depth; code: `sources/providers/directory-values.ts`):
  - _Placeholders are absent._ A cell that is empty, punctuation only, zeros only, a run of `x`
    (`xx`) or a placeholder (`-`, `–`, `n/a`, `na`, `n/k`, `none`, `nan`, `null`, `undefined`,
    `unknown`, `unspecified`, `not provided`, `not specified`, `tbc`, `tba`, `?`, `.`, spreadsheet
    errors `#N/A` `#VALUE!` `#REF!` …) counts as no value (a placeholder name is `missing_name`). A
    town must have at least 2 letters, and `x`, `various`, `other` are no town (a town never makes a
    row less bare anyway; the list keeps junk out of the head-office location). A register id is a
    placeholder only when **all its digits are zeros** (`00000000`, `SC000000`, `00-0000000`), in
    any namespace; repeated or sequential digits (`11111111`, `12345678`) and zero-padded numbers
    (`00012345`) can be real issued numbers and are kept.
  - _A registrable domain_ for the Domain column and the Website host (re-verification #12): the
    host must be on an ICANN public suffix (tldts, private suffixes off) — `jane.smith`,
    `acme.notatld` and `r.wjb3n` are dropped, so an email's local part never becomes the
    identity domain; a Careers URL host must be ICANN-registrable too (`https://jane/at/…` is
    dropped).
  - _A domain refusal list_ for the Domain column and the Website host: personal email providers
    (exact, e.g. btinternet.com, sky.com, t-online.de, orange.fr, and by label on any public
    suffix: hotmail, outlook, live, yahoo, gmx, aol, icloud, protonmail, …), shared hosting / site
    builders / link-in-bio / social hosts (sites.google.com, Google Maps on any Google domain,
    \*.wixsite.com, \*.wordpress.com, \*.blogspot.com, \*.github.io, linktr.ee, facebook.com,
    linkedin.com, …), URL shorteners (bit.ly, tinyurl.com, …), government and company-information
    sites (gov.uk, service.gov.uk, opencorporates.com, …) and reserved or junk domains
    (example.com/.org/.net, test.com, the TLDs `.test`, `.invalid`, `.local`, `.localhost`,
    `.example`, `.internal`), plus google.\*/search, lnkd.in, youtu.be, trustpilot.com and
    apply.workable.com. A refused **Domain** cell or **Website** host is dropped (row warning
    `invalid_domain` / `invalid_website`).
  - _Drop vs refuse_ (ruling b24e5dd): a problem in the **required name cell** refuses the row
    (row error); a problem in an **optional cell** — legal name, town, country, domain, website,
    careers URL, register id, id — **drops that cell** and keeps the row, with a coded row warning
    `{ line, code, column, message }` (column and row number only, a fixed message, never the
    text). A dropped cell's text is stored nowhere, and bare status is judged on the kept cells
    only ("Dublin 2", "Paris 8e", "London EC1": the town is dropped, the row kept). Register-id
    cells are normalised first: a value that normalises to a valid id is an id, never read as a
    phone (D-U-N-S `01-234-5678`, EIN `01-2345678`).
  - _Canonical text cells_ (rulings 64d97b4, d232db7). Every text cell — name, legal name, town,
    country, id, register ids — is **canonicalised**: made well-formed (a lone surrogate, from the
    cell or from an entity or escape such as `&#xD800;`, becomes U+FFFD — exactly as BSON stores
    it, so what is checked is byte-for-byte what is stored), HTML entities (`&#64;`, `&#x40;`,
    `&commat;`, `&amp;…`, any number of leading zeros) and percent-escapes decoded, NFKC, and
    every default-ignorable, invisible or format code point (zero-width characters, soft hyphen,
    bidi marks, variation selectors, invisible operators, CGJ, BOM, tags; `&shy;`, `&zwsp;`,
    `&zwj;`, `&zwnj;`, `&NoBreak;` decode to them) turned into a **space**, whitespace collapsed —
    **repeated until the value no longer changes** (a true fixed point: a 30-deep `&amp;` nest is
    decoded to its end). A cell that has not converged within **64 rounds** is **undecidable**:
    an optional cell is dropped (`contact_value`), a name refuses the row
    (`contact_value_undecidable`). The **length limit (2 000 characters) holds for the canonical
    form** too (NFKC expands: U+FDFA is 18 characters): over it, the column's `invalid_*`
    (`invalid_name`, `invalid_town`, `invalid_country`, `invalid_external_id`; the id column
    `value_too_long`), and a URL cell whose NFKC form is over it is `invalid_domain` /
    `invalid_website` / `invalid_careers_url`. The canonical text is what is **checked, stored and used for the
    record and name keys** (`Marks &amp; Spencer plc` is stored and keyed as `Marks & Spencer
plc`; the same file always maps to the same keys). A kept cell whose canonical form differs from
    the cell as written (whitespace aside) gets the row warning **`value_normalised`** (column
    only; like every row warning it is counted in the snapshot's one `parser_failure` review). The
    check fails closed on both forms: the canonical text **and** the cell as written, each read
    as decoded, with default-ignorables removed (`jane a\u200et` → `jane at`) and turned into
    spaces, `。．｡` folded to `.`, an orphan combining mark read as a separator — and each
    **skeleton**: NFD with every mark removed (`àt`, `a\u{16FE4}t` → `at`), then every code point
    outside letters, digits, ASCII punctuation and space turned into a space (the ruled skeleton)
    or, failing closed, non-ASCII symbols removed with all punctuation kept (`a\u{1D159}t` → `at`,
    `»á«` → `»a«`). A hit on any reading counts. For a name, legal name or town the **derived
    strict and loose name keys** are checked too (the address grammar and the 9+ digit rule:
    `jane at acme\u200bdot\u200bcom`, `07700ß900123`).
  - _Contact values_ (`contact_value`), structurally (rulings f89df42, b24e5dd, af1b342), on those
    readings:
    - **email** (the standard notations), by **one grammar** (`contact-grammar.ts`; ruling
      af1b342): any `@`-like character (`@`, `＠`, `﹫`) in any cell — including a URL or domain
      cell (`https://acme.com\@gmail.com`, a handle `@janesmith`); and every member of
      `LOCAL AT-FORM LABEL (DOT-FORM LABEL)+`, where an AT-FORM is an `@`-like character, `at` or
      `arroba` as a whole word, or `(a)` in a bracket pair whose closer pairs with its opener
      (Unicode included: `«a»`, `【a】`, `〔a〕`; quote pairs in either order: `»a«`, `„a“`,
      `﴾a﴿`; `「a⟧` is the label `a` in brackets); a keyword spelled in letters (`at`, `arroba`,
      `dot`) may also be the local part or a label (`jane at at dot com`, `dot at acme dot com`,
      `arroba at acme.com` — every reading is tried, within a bounded search); a DOT-FORM is `.` or `dot` as a whole word; brackets and every other
      non-letter/digit character are separators, allowed in any run around each form — between
      labels any run of separators and dot-forms holding at least one dot-form (`acme.dot.com`,
      `acme(dot).com`, `acme .[dot]. com`, `mail.acme.dot.co.dot.uk`)
      (so `[at]`, `( AT )`, `{dot}`, `<.>`, `[ . ]`, `-[dot]-`, `_(dot)_`, `–dot–`, `'dot'`, `*`,
      `~`, `|`, `,`, `:`, `+`, `·`, a zero-width space… all match); and the joined labels form a
      registrable domain on an ICANN public suffix (tldts; Unicode `рф`, `中国` and punycode
      `xn--p1ai` suffixes included), with **no exemption** (rulings c1a3500, 621f14c). The text is
      tokenised twice — a hyphen as a separator (`jane-at-acme-dot-com`, a punycode `xn--` kept
      whole) and a hyphen inside labels (`smith-consult`, with whole hyphen-delimited `at`/`dot`
      split out) — and a label chain may run into hyphen-joined text (`acme-corp.com-ref7`, a job
      slug: the last label is also tried cut before each hyphen run). Also `#` followed by a
      registrable domain (`jane#acme.com`); `mailto`; a profile link written in text
      (`linkedin.com/in/jane`). **The tests are generated from the grammar** (17 at-forms × 14
      dot-forms × 18 separators, `.` included × 7 suffixes × 3 label prefixes, 2–5 labels in all ×
      2 trailing contexts = 175 938 members, each refused as a name and dropped as a legal name,
      town and careers path), with a generated negative set (232 names, 13 hosts in 3 URL cells)
      that stays kept, and a **permanent seeded fuzz** (6 000 members: random separator runs of
      up to 3 characters with `.`, Unicode brackets, NBSP, tab and zero-width; 1–4 labels with
      Unicode, digit and punycode labels; locals `jane.smith`, `jane+x`, …; checked as text, in a
      URL path and in a URL query: 0 misses). The matcher is linear: a label chain stops past 253
      characters or 127 labels (no hostname is longer) and the tokeniser matches in place; a perf
      test bounds adversarial 2 000-character rows at 2× their 748b382 cost;
    - **phone**: in name, legal name and town, **any 9 or more digits separated only by
      non-letters** — every dash (`\p{Pd}`), `_`, `·`, `•`, `,`, thin and no-break spaces,
      brackets — counting digits of every script (`\p{Nd}`; full-width and mathematical digits via
      NFKC), a token of digits mixed only with `o`/`O`/`l`/`I` (`o77oo9oo123`) read as digits — exactly
      the ruled bar (ruling 621f14c: no 7-digit rule, so `9123-4567 Québec inc.` is a name); the
      international / national phone shapes (9–15 digits) in every cell, and a messaging handle or contact link in text (`skype
jane.smith`, `discord jane#1234`, `t.me/jane`, `t.me jane`) — a handle needs a
      handle-shaped token (an internal `.`, `_` or `#` followed by more characters, 5+ digits, or
      `+` and digits) and never a legal form, so `Discord Inc.`, `Signal 88 LLC`, `Signal S.A.`,
      `Insta 360 Ltd`, `Slack Inc.` are names. **The handle rule is a text-cell rule** (ruling
      47c0f5c): name, legal name (and its trading-as), town and id — URL and Domain cells are
      never scanned for handles (`signal-iduna.de`, `slack.co.jp`, `signal.co.uk` stay identity).
      When a platform word (`skype`, `whatsapp`, `telegram`, `signal`, `wechat`, `viber`,
      `discord`, `slack`, `snapchat`, `insta`/`instagram`, `kik`, `threema`, `kakao`/`kakaotalk`,
      `twitter`; not the common words `line`, `wire`, `teams`, `session`, `element`, `zoom`)
      appears **anywhere** in the cell, **every** token before and after it is examined
      (`Acme jane.doe on skype`, `jane.doe (skype)`); a token is letters and digits joined by `.`,
      `_`, `#` or a dot-like character (`·`, `•`, `‧`, `・`, `･`, `∙`, `⋅`, `⸱`, `᛫`, `ꞏ`, `⸳`, read as
      `.`), and every other character (`-`, `/`, `|`, `=`, `:`, brackets, spaces) separates tokens
      — `skype - jane.doe`, `skype=TOM.LEE`, `skype ID jane.doe`, `skype(jane.doe)`,
      `skype.jane.doe`, `skype jane·doe` are handles. Also handles (ruling ed7b71a): a run of **7 or more
      digits** (joined by spaces, hyphens or dots) whose nearest token is a platform word
      (`whatsapp 91234567`, `viber 555 1234`, `whatsapp 555-1234`); an `<alnum>:<alnum>` pair next
      to a platform word (`skype live:janedoe`); a run of joiners reads as one (`jane__doe`,
      `jane..doe`, `jane._doe`); `٫` and `۔` join like `.`. A token is **not** a handle when it
      is digits alone elsewhere (`Omaha NE 68102`, `Acme signal 123456`), anything after a registry
      marker (`No.`, `Nr.`, `Reg.`, `VAT`, `#`: `(Company No. 12345678)`, `Reg. No. 01234567`), a
      **self-referenced domain** (ruling ed7b71a, amending 47c0f5c) — exactly a registrable domain
      or `www.` and one whose registrable label, hyphens removed and case ignored, is the
      concatenation of one or more consecutive **other** words of the cell, or a platform's own
      name, and whose nearest tokens are not the platform word (`Slack Ltd t/a Slack.com`,
      `Signal AI Ltd (signal-ai.com)`, `Signal Hill Corp. (SignalHill.COM)`, `Signal.co.uk Ltd`;
      never `skype min.kim`, `WeChat: wei.wang`, `skype tom.green`, `skype jane.com`, `telegram
janedoe.io`: a surname can be a TLD) — or when every dotted part is a single capital, digits, a
      capitalised legal form or abbreviation, or a lower-case abbreviation (`est`, `publ`, `dba`,
      `fka`, `nka`, the connector `e`): `Tech.Ltd`, `Mfg.Co.`, `Bros.Inc.`, `Hldgs.Ltd.`,
      `Tic.Ltd.Şti.`, `P.Ltd`, `est.2011`, `Cía.Ltda.`, `Soc.Coop.`, `Ind.e Com.Ltda.`,
      `Co.Reg.No.01234567`; a lower-case single letter beside such parts (`Kakao i.Corp`), except
      `z`, `j` and `k`, which only `Sp.z`, `Sp.j` and `Sp.k` accept; `…ges.m.b.H`. **Legal
      forms**: ltd limited inc incorporated llc llp lllp pllc plc corp corporation co company sa sas
      sarl bv bvba nv gmbh ag kgaa srl sl slu spa pty lp oy oyj ab as asa aps kg se ev kk sro doo pc
      pa ooo oao zao pao ao ug kft zrt sp zoo spzoo oü uab sia bhd sdn pte pvt ltda şti me eirl sab
      cv rl wll fze fzco fzllc hf ehf. **Abbreviations**: tech mfg mfgs mfr mfrs bros hldg hldgs
      holdg dept div int intl natl grp ass assoc assn mgmt mgt svc svcs serv ind inds indus eng engg
      gen univ inst fdn ctr dev mkt mktg prod prods dist distr trad tic san ent ents inv invest cap
      fin ins mut coop lux wash calif mass penn ft jr sr est sp ges cía soc com reg no nr (compared
      without accents). Lower-case
      legal forms are a handle even when they spell a domain (`signal co.ltd`). `No`/`Nr` + digits
      and `St`/`Mt`/`Ft`/`Dept`/`Div` + one capitalised word apply only to the **whole** token
      (`No.1`, `St.Petersburg`, `Dept.Sales`; `St.Jane.Doe` and `No.1.jane` are refused). A title
      is never an abbreviation: next to a platform word `Mr.Brown` is refused
      (`Discord Holdings Ltd., c/o Mr.Brown` — a title and a surname is the shape of a handle; the
      same text without a platform word is kept); a profile or contact link needs a host boundary
      that is no letter, digit, `.` or `-` (`acme-fb.com`, `space-x.com` are hosts). There is **no exemption of any kind**
      (rulings c1a3500, 621f14c): a name with 9+ digits across non-letters is refused whatever
      follows it;
    - **town**: a town may contain **no digits at all** (the town is dropped: `invalid_town`);
    - **Website and Careers URL cells are reduced, not parsed** (ruling 29b6592). The cell is
      split as written (a backslash read as `/`) into scheme, authority and path; only `http` and
      `https` are accepted, and a contact scheme (`mailto:`, `tel:`, `sms:`, `callto:`,
      `whatsapp:`, `skype:`) drops the cell. The **query and fragment are never stored**. The
      path is kept only when it is **plain** — only `A–Z a–z 0–9 . _ ~ / -` as written, no
      at-form or dot-form token under either hyphen tokenisation (`/careers/senior-engineer`
      is kept), and no platform word as a token of the path, query or fragment (ruling ed7b71a:
      `/skype/jane_doe`, `/careers/whatsapp/91234567`, `?skype=jane.doe`; hosts stay out of the
      handle rule, an accepted residual) — otherwise **only the origin** (`https://host[:port]/`) is stored and the row gets
      the warning **`url_reduced_to_origin`** (Careers; the Website always stores its origin). So
      every escape, entity, `#`, `@`, bracket or dot word in a path is reduced away
      (`https://jane.at/%23gmail.com`, `…/%2523gmail(dot)com`, `…/x&num;gmail(dot)com`,
      `https://acme.co.uk/jobs%23jane-at-gmail` → the origin), and so are dotted and locale
      paths (`/jobs/index.html`, `https://www.omv.at/de-at/karriere`,
      `https://www.redbull.com/at-de/jobs` → the origin). **The host fails closed**: an `@`-like
      character in the decoded authority, or an at-form token in the host **before** its public
      suffix (`jane-at-acme.co.uk`, `https://at.com/`, `https://www.at.at/`), drops the cell; an
      at-form that **is** the public suffix (`.at`, `co.at`, `or.at`) drops the cell only with a
      plain path that is domain-shaped (`https://jane.at/gmail.com`, `…/gmail/dot/com`,
      `…/gmail.com/careers`) — any other `.at` path is plain and kept (`https://acme.at/jobs`) or
      reduced to the origin. The host must be ICANN-registrable; a trailing dot is removed and
      a default port dropped.
    - **Check what you store** (ruling bd6ad44). The value to store is computed first — for a
      Website / Careers URL the WHATWG-serialised origin plus any kept path, for a Domain the
      registrable domain — and the **full contact detector, at-words on**, runs on that exact
      string and on both forms of its host: the serialised punycode (whose label tokenisation reads
      a hyphen-delimited `at` inside `xn--jane-at-gmail-6ua`) and its Unicode form
      (`domainToUnicode`: `xn--janeatgmail-…` reads `jane¡at¡gmail`); any hit, or an undecidable
      search, drops the cell (`contact_value`). The
      serialised host must also **be the written one** (in its punycode or Unicode form): a host
      IDNA maps to something else — deleted default-ignorables, `a¡t` → `xn--…-at-…`, `a™t` →
      `atmt`, full-width letters — is dropped (the cell's invalid code). **Invisible code
      points**: a Domain, Website or Careers URL cell holding any default-ignorable, format or
      bidi-control, control, line/paragraph-separator or blank code point (soft hyphen, ZWSP, word
      joiner, CGJ, variation selectors, Mongolian selectors, tags, BOM, `U+202A–202E`,
      `U+2066–2069`, …), as written, percent-decoded or entity-decoded (`%C2%AD`, `&shy;`), is
      dropped (the cell's invalid code). **A Domain cell is a bare host** (ruling 64d97b4): an
      optional `http(s)://` and an optional trailing `/`, nothing else — any path, query, fragment
      or backslash is `invalid_domain` (`google.com//maps/place`, `google.com/%6Daps`,
      `google.com/&#x6d;aps`, `https://www.acme.co.uk/about`). **Domain identity is never taken
      from a shared host**: map, search, cache, translation, archive and link-shortener hosts —
      Google's map, search, translate and business hosts and its `/maps`, `/search`, `/url`,
      `/amp`, `/translate` pages on every Google domain, `maps.apple.com`, `bing.com`,
      `duckduckgo.com`, `openstreetmap.org`, `archive.org`, `archive.ph`, `archive.today`,
      `googleusercontent.com`, `translate.goog`, `ampproject.org`, `share.google`, `g.co`,
      `goo.gl`, `map.baidu.com`, `maps.here.com`, `waze.com`, `2gis.ru`, `startpage.com`,
      `ecosia.org`, `search.brave.com`, `ask.com` (ruling 47c0f5c) — plus the existing site-builder, ATS and social list; a real company on such a host
      gets its identity from another source (ruling d232db7 adds Google's `images`, `lens`, `news`,
      `scholar`, `books` and `shopping` hosts and `mapquest.com`). These refusals read the Domain /
      Website cell as written — its path decoded and `//`-collapsed, as parsed and from the fully
      decoded cell (`/%6Daps`, `/&#x6d;aps`, `//maps`, `/%73earch`, `/%75rl`, `//url`, `/%2Furl`) —
      before origin reduction (`https://www.google.com/maps/place/Acme+Ltd` in a Website
      is `invalid_website`, never `https://www.google.com/`); a Website's origin host is its
      website only when it is not on the list. The website **derived** from a Domain
      (`https://<domain>/`) passes the Website rules, the stored-value check included: `at-home.co.uk`
      is kept as a Domain with no website, exactly as a Website cell `https://at-home.co.uk/` is
      dropped.
    - **URL cells** (Domain, Website, Careers URL): the whole cell decoded (HTML entities and
      percent-escapes, until stable) and scanned — an `@`-like character anywhere
      (`https://jane&commat;acme.com/careers`, `https://jane%26commat%3Bacme.com/careers`,
      `https://acme.com&commat;gmail.com/careers`) and every other contact value except the `at`
      notation; the **host** decoded and scanned the same way, plus 9+ digits separated only by
      non-letters in the host (`https://07700900123.acme.com/`, `call-07700-900123.acme.co.uk`,
      Domain `07700900123.co.uk` — never an identity domain); URL credentials; contact-link hosts (wa.me,
      wa.link, whatsapp.com and its subdomains, t.me, telegram.me, telegram.dog, m.me, signal.me,
      viber.me, calendly.com, cal.com, zoom.us, meet.google.com, teams.microsoft.com); every
      path is scanned **raw and decoded first** (ruling 621f14c): a digits-only segment shaped
      like a phone (10–13 digits starting 0, 00 or 44), an email, phone or handle anywhere in it (a
      LinkedIn job slug included); then 9+ digits separated only by non-letters in the decoded
      path, where the only id set aside — after the slug was scanned — is a **trailing
      LinkedIn-shaped id** — a company id of at most 9 digits ending `linkedin.com/company/<id>`, or
      a job id of exactly 10 digits not starting with 7 (a UK mobile without its 0) ending
      `/jobs/view/<slug>-<id>` (`linkedin.com/company/07700900766`, `/company/7700900123`,
      `/jobs/view/7700900123`, `/jobs/view/abc-447700900123`,
      `/jobs/view/call-07700-900-877-3912345678` and `/jobs/view/jane-at-acme-dot-com-3912345678`
      are dropped; a query's numeric ids, `/jobs/search/?currentJobId=3912345678`, are not
      phone-shaped and are kept); a person's page (`/team/<x>`,
      `/people/<x>`, `/staff/<x>`, `/profile/<x>`, `/author/<x>`, …) or a vCard (`.vcf`); an email
      or phone in the query or fragment. Each drops the URL (the row is kept).
    - **Careers URLs on social or profile hosts** (linkedin `/in/` and `/pub/`, facebook,
      twitter/x, instagram, github, gitlab, about.me, linktr.ee, medium.com and `*.medium.com`,
      substack, tiktok, youtube, xing, wellfound.com and angel.co (`/u/…`), behance.net,
      dribbble.com, …) are dropped (`profile_url`) unless the page is an organisation or jobs page
      (`linkedin.com/company/…`, `/school/…`, `/showcase/…`, `/jobs/…`; `wellfound.com/company/…`,
      `/jobs`; `dribbble.com/jobs`; `behance.net/joblist`). The path is normalised first (`//`
      collapsed) and a person marker (`in`, `pub`, `u`) anywhere in it is a profile
      (`linkedin.com/company//in/jane` is dropped).

    **The search fails closed** (ruling 6bff30e): the bounded address search has a cost budget
    (token visits and domain parses, one budget per text for both tokenisations); a text it
    cannot decide within it counts as a contact value — an optional cell is dropped
    (`contact_value`) and the required name refuses the row with **`contact_value_undecidable`**.
    A prune discards only impossible readings (ruling 29b6592): a label over 63 characters
    **measured in punycode** (`domainToASCII`) is never a domain label, but the hyphen cuts of a
    label (`smith-consult.com-aaaa…`, `acme-group.com-a1-a1…`) are tried **before** the label's
    length is checked, so a long hyphenated tail never hides the address before it. Every expensive
    primitive of the search — the punycode length (`domainToASCII`) of a non-ASCII label and the
    PSL parse of a label chain — is **memoised** and **charged to the budget** on every call (so a
    verdict never depends on what was mapped before); a label of more than 3 × 63 code points
    that IDNA keeps is too long without being encoded. Detector cost:
    an adversarial corpus (11 shapes of ~2 000-character cells in every cell of a row) costs at
    most ≈10 ms per row, pinned at ≤ 50 ms; a **hill-climbed corpus** covering every mapped column
    (name, legal name, town, country, id, Domain, Website, Careers URL and every register-id
    column, alone and all at once, with zero-width variants, the re-verification #15 and #16 shapes
    included) is pinned at **≤ 100 ms per row**, and a **bounded random hill-climb** (fixed seeds,
    12 steps from the pinned shapes of every column) runs in CI under the same bound. Costs are
    measured **cold-cache**: no warm-up run, the detector's caches cleared before each timed run;
    the corpus and the climb units include the NFKC-expansion shape (U+FDFA). The 3 × 63 IDNA
    bound is pinned by 43 decomposed Hangul syllables (129 code points, 50 characters encoded).
    A **Country** cell longer than 64 characters is `invalid_country` before any taxonomy lookup. The
    map node checks its abort signal at every pause (`throwIfAborted`): a timed-out, cancelled or
    lease-lost run stops. Dot words are `dot`, `punto`, `punkt`, `point`, `ponto`, and `·`, `‧`,
    `•` are dot-forms; `(a)` pairs by Unicode `Bidi_Paired_Bracket` (BidiBrackets.txt, embedded:
    `⦍a⦐` pairs, `⦍a⦎` does not), `<>`, `﴾﴿` or any two quotes (`"a"`, `'a'`, `〝a〟`, `⹂a“`), and
    a paired `(a)` may also be the label `a`. A handle-shaped token after a messaging word is exempt
    **only** when it is single letters around dots (`Signal e.V.`, `Signal U.S.A. Inc.`), a
    version (digits, optionally `v`-prefixed: `Snapchat 3.0 Ltd`, `Signal v2.0`), capitalised
    legal forms (`Signal Co.Ltd`, `Viber S.à r.l.`), `No`/`Nr` before digits (`Signal No.1 Ltd`),
    or `St`/`Mt` before a capitalised word (`Telegram St.Petersburg OOO`) — ruling 29b6592 (3)
    plus `v` versions, nothing else. The acronym-before-a-legal-form exemption of 64d97b4 never
    applies after a platform word (ruling d232db7), so `Slack E.ON SE` is refused (an accepted
    over-refusal), as are `skype J.DOE Ltd`, `skype TOM.L Ltd`, `skype A.TOM Inc`, `skype TOM.LEE.X
Ltd`. There is no title, initial-dot-surname or capital-handle exemption: `Acme skype v.petrov`,
    `Acme telegram v.ivanov`, `Acme skype dr.smith`, `mr.jones`, `ms.lee`, `st.john`, `nr.jansen`,
    `Nr.Five`, `V.PETROV`, `v2.petrov`, `TOM.LEE`, `JOE.DOE`, `BOB.KIM`, `AL.B`, `TOM.LEE Ltd` and
    `Acme signal co.ltd` are refused.

    **The per-row cost bound is structural** (ruling 47c0f5c): each row has a fixed work budget
    (`DIRECTORY_ROW_BUDGET`, 100 000 grammar units — a token visited, 20 per domain parse, a
    tokenised character, one per 8 characters of each reading scanned) shared by every detector
    call in the row (the handle rule's token walk and domain parses included); tokenisations and
    verdicts are memoised per distinct text **within the row only** — emptied when a row begins,
    never cleared mid-row, nothing memoised outside a row (ruling ed7b71a) — and
    charged on a miss, so the charge is deterministic. A spent budget makes every later detector
    call undecidable: optional cells are dropped (`contact_value`) and a name refuses the row
    (`contact_value_undecidable`). A typical row uses about 200 units, the longest legitimate row
    measured about 25 000; the wall-clock perf test is a regression check on top.

    **Known over-refusals** (graded Low): a name that reads as an address (`Eat at Joe.com`,
    `Life at Work.Com Ltd`, `Tea at Polka dot Ltd`, `Coffee at Home dot Co`, `Tea at Polka dot
Cafe`, `Lunch at Noon dot Kitchen`, `Eat at Joe dot Shop`, and "X at Y. Co" names: `Lunch at Work. Co`, `Chef at Home. Co. Ltd`,
    `Gym at Hub.Co Ltd`, `Smith (a) Co. Ltd`, `Holdings (A) Co. Ltd`: the row is refused), a
    Website or Careers URL whose host holds an at-form before its public suffix
    (`https://jobs-at-acme.com/`, `https://at.com/`, `https://www.at.at/`: dropped, the row and
    the Domain are kept; a Domain cell is read as a domain, so `at-home.co.uk` stays a Domain, but
    `jobs-at-acme.com` reads as an address when stored — `jobs@acme.com` — and is dropped as a
    Domain too, ruling bd6ad44)
    or whose `.at` host has a domain-shaped plain path; a careers path that is not plain
    (`/life-at-acme/`, `/careers-at-google`, `/de/at/jobs.do`, `/jobs/index.html`, locale paths
    `/de-at/…`, `/at-de/…`, any query: only the origin is kept, `url_reduced_to_origin`);
    **the "X at Y Point Ltd" family**: a name holding `W at L (D L)* D S`, where `at` is a whole
    word, each `L` one word, each `D` a dot word (`dot`, `point`, `punto`, `punkt`, `ponto`) and
    `S` a word that is an ICANN public suffix — which includes `Ltd`, `LLC`, `Inc`, `GmbH`, `AG`,
    `SA`, `Co`, `Company`, `Limited`, `SRL`, `BV`, `AS`, `KG`, `SpA`, `SARL`, `LLP`, `Cafe`,
    `Shop`, `Kitchen`, `Bar`, `Pub`, `Restaurant`, `Hotel`, `Group`, `Holdings`, `Partners`,
    `Services`, `Solutions`, `Consulting`, `Studio`, `Design`, `Media`, `London`, `House`,
    `Care`, `Life`, `Work` — is refused (`West Point at Harbour Point Ltd`, `Bar at Pier Point
Ltd`, `Coffee at Home Point Cafe`, `Lunch at Noon Punkt GmbH`, `Rooms at Harbour Point Hotel`);
    two words between `at` and the dot word, a non-suffix last word or a longer word are kept
    (`Canary Wharf at One Canada Point Ltd`, `Studio at Mill Point Plc`, `Tea at Polka Pointe
Ltd`); a careers path with a 9+-digit job id outside LinkedIn — `boards.greenhouse.io/acme/jobs/4012345678`,
    SmartRecruiters 15-digit ids, `/job/…/1234567890/` (only the careers URL cell is dropped; the
    row and board-level URLs are kept) — a
    name with 9+ digits in total across non-letter separators (`Acme 2019 / 2020 / 2021`), and
    **numbered companies with 9+ digits** — an Australian ACN (`004 085 616 Pty Ltd`, `ACN 004
085 616 Pty Ltd`) and a 10-digit Ontario number (`1000123456 Ontario Inc.`) are refused;
    Quebec numbered companies (`9123-4567 Québec inc.`, `9123 4567 Québec inc.`, 8 digits), 7-digit
    Ontario/Alberta/B.C. numbers and `BC1234567 Ltd` pass.
    **Documented residuals** (graded Low; deliberate obfuscation beyond the standard notations —
    free text cannot be proven free of personal data, and the raw snapshot holds the upload
    anyway): no at token (`jane.smith gmail.com`, `jane dot smith gmail`), no top-level label
    (`<jane.smith AT acme>`, `jane at gmail`), a spelled `dot` before a label that is no public
    suffix (`jane at acme dot corp`, `dot pty`, `dot lp`) or a mangled `dot` (`d0t`, `dotcom`),
    **7- and 8-digit local numbers in a name or legal name** (`Acme 555-0123 Ltd`, `Smith 020
7946`: below the ruled 9-digit bar), homoglyphs (`jane ⓐ acme.com`, Cyrillic `о` in
    digits), letter-split or spelled digits (`O77OO 9OO 123`, `07700 nine 00123`), no-separator
    host strings, the `at` notation inside a Domain cell that does not read as an address when
    stored (`at-home.co.uk`; `jobs-at-acme.com` reads `jobs@acme.com` and is dropped), homoglyph
    at- and dot-forms from other scripts (Cyrillic `а`/`о`, `ⓐ`; ruling 64d97b4 — accented Latin
    forms such as `àt` and `(à)` are caught by the skeleton), letters spelled out with
    separators (`c-o-m`), non-ASCII digits in a host that punycode hides
    (`https://०७७००९००१२३.acme.com/`), a phone-shaped Wikidata id (`Q447700900123`, the
    register-id carve-out), a 10-digit US-shaped number as a LinkedIn job id, and a person's name without any marker (`/careers/jane-smith`, "Jane Smith
    Consulting").

  - URL cells also scan the path, query and fragment **as written** (backslashes read as `/`)
    before URL parsing normalises them (`/jane/at/acme/./com`, `\jobs\jane\at\gmail\.\com`).
  - _Careers URLs keep scheme + host + path_; the query and fragment are dropped entirely.
    **Record key** (what makes a row "the same record" on re-import): the `id` column — **never
    stored raw**: `id:` + the first 128 bits (32 hex) of SHA-256(`sourceId` + NUL + the value
    NFKC-normalised and whitespace-collapsed, not case-folded: `R-1` ≠ `r-1`); in-file duplicates are detected on the
    hash, and the row number stays the operator's trace — else the
    first register id (`<namespace>:<id>`, namespaces sorted), else `name:<strict name>|<country>`
    when the row has a country (or `defaultCountry` for an empty country cell), else `domain:<domain>`, else
    `name:<strict name>|`. Name + country ranks above the domain: sister companies share a domain,
    and a domain changes more often than a name. Without an `id` column the import warns (in the
    `map` and `finalize` outputs and the report): renaming a company in the file makes it a new
    record. Names are keyed Unicode-aware (`name-norm/2`: NFKC, case-folded; letters of every
    script kept, so "ООО Ромашка" and "東京電力" keep distinct keys). Stored keys are never
    replaced: the resolver looks names up by their name-norm/2 **and** name-norm/1 keys, and a
    company found only by a v1 key whose own name differs under v2 is a review candidate, never an
    automatic match. Migration `2026-09-30-005-market-company-name-keys-v2` adds the v2 `name:` key
    beside every stored v1 key that differs, on active companies only (additive, idempotent, logs
    the counts). A v2 key another company already holds is not added and is counted as a clash;
    a clash shows up as the "Several companies share the legal name" review the next time a row
    with that name is resolved. **Known v1 → v2 differences:** letters of
    non-Latin scripts are kept (v1 dropped them: "ООО Ромашка" had an empty key, "Café 東京 Ltd" was
    `cafe ltd`, now `cafe 東京 ltd`); a compatibility character that NFKC maps to a non-Latin letter
    becomes that letter (`µ` micro sign → `μ`, `Ω` ohm sign → `ω`; v1 made it a separator). Every
    other input — Latin letters and diacritics, `ŉ`, modifier letters (U+02B9–U+02EE), combining
    marks outside U+0300–U+036F, punctuation — keys exactly as in v1 (property-tested).
    **Bare names (rulings d819f87, ba9e150):** a directory row is non-bare **only with a valid
    register id or a mapped, non-refused Domain**; a legal form (Ltd, PLC, GmbH, …), a town or a
    country never lift bare status ("John Smith Ltd, Leeds, UK" is bare). A bare row never
    auto-matches and never creates a company: it becomes a low-severity `company_resolution`
    review offering the company it would have matched (if any); its dedupe key includes the
    normalised country and legal name (India Tools GB and India Tools IE are two reviews).
    **Volume and remedy:** a file that maps neither a Domain column nor any register-id column
    therefore sends **every row** to review (one review per distinct name, country and legal name).
    The upload response (`warnings[]`) and the import report warn about it at plan time; the
    remedy is to map a Domain column or a register-id column (e.g. `gb_companies_house`).
    The file's own `id` column is a record key, not identity evidence, so it does not make a name
    less bare. **Sole-trader names are business identifiers only**: a directory row naming a person
    ("Jane Doe", "Dr J Smith") is a business name; Market never links it to a Professional subject
    or infers anything about the person. **Residual risk:** a sole trader registered in a register
    namespace (e.g. a Companies House number for a one-person company) carries identity evidence,
    so such a row can resolve automatically; the register id identifies the business, but the
    business name may still be a person's name. Consumers must treat directory company names as
    business identifiers only.

- **Register ids from every provider** are normalised to their namespace format when an
  observation is recorded (`market.create_company_observation` and every other writer:
  `445790` → `00445790`); an id that does not fit its namespace, or an unknown namespace, is kept
  as given.

- **Row warnings** (a kept row with a dropped optional cell): `{ line, code, column, message }`
  with codes `contact_value`, `value_too_long`, `invalid_name` (legal name), `invalid_domain`,
  `invalid_website`, `invalid_careers_url`, `profile_url`, `invalid_country`, `invalid_town`,
  `unknown_id_namespace`, `invalid_external_id`. They are listed in the import report
  (`rowWarnings[]`), counted in the map output (`rowWarningCount`), the finalize output
  (`rowWarnings`) and the `parser_failure` review context (`rowWarnings`); warnings alone raise
  no review (the report is still written).
- **Row errors** (a row that is not imported; nothing is dropped silently). A row error carries
  `{ line, code, column?, message }`: the row number, the code, the mapped column (a header name
  from the column map) and a **fixed message for the code — never cell text** (only the raw
  uploaded snapshot holds cell text; the same holds for review items, node outputs and both
  import reports):

  | Code                        | Row                                                                                                        |
  | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
  | `malformed_row`             | malformed CSV record (reader, above; the message names the reader problem)                                 |
  | `missing_name`              | empty or placeholder name                                                                                  |
  | `invalid_name`              | the name has no letters or digits                                                                          |
  | `value_too_long`            | the name cell is over 2000 characters (an optional cell is dropped)                                        |
  | `contact_value`             | a contact value in the name cell (an optional cell is dropped)                                             |
  | `contact_value_undecidable` | the detector could not decide the name within its budget (fails closed; an optional cell is dropped)       |
  | `duplicate_row_key`         | same record key as an earlier row; the message names the **row number** of the first occurrence (imported) |
  | `conflicting_external_id`   | the same register id is on rows with different names in this file; every such row errors (none imported)   |
  | `invalid_payload`           | the mapped row fails the observation contract (the message names the field path)                           |

- **Import report and review.** When rows were not imported or failed processing, the run raises
  (or refreshes, on re-runs) one `parser_failure` review per snapshot (dedupe
  `parser_failure:<sourceId>:<snapshotId>`), severity `high` when no row was importable, else
  `medium`. `context`: `{ sourceId, snapshotId, runId, rowCount, rowErrors, processingFailures,
outcomes: { matched, created, review, failed }, reportArtifactId, errors[≤20], failures[≤20],
retryInput }`. `allowedActions` is `['retry', 'dismiss']` only when rows failed processing (a
  retry re-processes the snapshot), else `['dismiss']` (fix the file and upload it again). A later
  run of the snapshot that imports every row resolves the open review (`resolution.action:
retry`, system actor; audit `review.resolved_obsolete`). The full report is a JSON artifact:
  fetch `GET /api/artifacts/:reportArtifactId/content` (`application/json`):

  ```ts
  {
    kind: 'company_directory_import_report';
    sourceId: string; snapshotId: string;
    parser: { name: 'company-directory-row'; version: '1' };
    rowCount: number; importable: number;
    outcomes: { matched: number; created: number; review: number; failed: number };
    warnings: string[];
    errors: Array<{ line: number; code: RowErrorCode; column?: string; message: string }>; // every row error, by line
    rowWarnings: Array<{ line: number; code: RowWarningCode; column: string; message: string }>; // dropped optional cells
    processingFailures: Array<{ line: number; code: 'processing_failed'; message: string }>; // rows that failed the pipeline (fixed message; the error is in the node logs)
  }
  ```

  The run's `finalize` output is `{ imported, rowErrors, processingFailures, outcomes,
reviewItemId, report, warnings }` (`imported` = matched + created + review).

- **Conflicts:** a row that disagrees with a canonical company never overwrites it. Same-authority
  disagreement on the official domain makes the fact `conflicting` and raises a `field_conflict`
  review (`field_conflict:company:<companyId>:domain`, actions `correct` / `dismiss`); a
  lower-authority value is kept as an alternate on the fact (`conflicts[]`). A register id or
  domain pointing to another company is a `company_resolution` review.
- **Runs:** `POST /api/sources/:id/run` without `snapshotId` is **400** (`details.param:
snapshotId`): nothing is fetched for an upload-only source. Reprocessing a snapshot
  (`POST /api/snapshots/:id/reprocess`, or run with `snapshotId`) is safe and idempotent.
- **Freshness:** a directory source has no schedule; `freshnessState` is the age of its last
  successful import (`health.lastSuccessAt`, processing time): `never_succeeded` until the first
  import, `overdue` once older than `freshness.maxAgeMinutes` — read it as "upload a newer
  file". Reprocessing an old snapshot also counts as a success (the file's own date is not
  known; a declared as-of date is a follow-up). A run that imports no row records a failure.
- **Idempotent:** re-uploading the same file returns the same snapshot (`unchanged: true`) and a
  re-run records nothing new. A directory never delists: absence from a later file proves
  nothing (retracting a directory's rows is a follow-up). Two directories that disagree on a fact
  keep both values as a conflict (`status: conflicting`, `quality.conflictFields`), never an
  overwrite.
- No schema change: the observation payload is the existing company observation contract.

### Known ATS board file (M8.2, provider `ats_board_directory`)

An operator-supplied CSV of known ATS boards, imported by `market.ats_boards.import`. Code:
`packages/market/src/sources/providers/ats-board-directory.ts` (reader and row rules),
`packages/market/src/sources/board-identity-import.ts` (per-row decision, OPS-1b),
`packages/market/src/sources/board-liveness.ts` (liveness fetch) and
`packages/market/src/workflow-nodes/imports.ts` (steps). Imports: `market-imports.md`.

- **Register:** `category: manual_import`, `provider: ats_board_directory`,
  `acquisition.workflowKey: market.ats_boards.import` (the only workflow; any other is 400),
  `governance.accessMethod: manual_upload`. `authority.tier` defaults to `third_party`; registry
  or operator authority is 400, as for M8.1. Upload-only: no schedule, no endpoint, and the
  generic run routes refuse it without a `snapshotId`, as for M8.1.
- **Config:** `acquisition.config.columns` = `{ provider?, token?, company?, domain?, url? }`.
  Map `provider` and `token`, or `url` (OPS-1b). At least one of `company` or `domain`. A header that names personal data is refused (400). Limits:
  `maxBytes` default 5 MB, `maxRows` default 5000 (at most 20000).
- **Reader:** the M8.1 reader and header rules. Every file column must be mapped and every mapped
  column must be in the file. Checks run before storage; a refused file stores nothing.
- **Row rules:** `provider` is `greenhouse`, `ashby` or `lever` (case-insensitive). `token` must
  be a valid board token. `domain` must be a registrable company domain. A board or job `url` on
  a known board host gives the provider and token when those cells are empty (hosts in
  `market-imports.md`); when they are filled they must agree with it. An EU URL sets the EU host
  (key `provider:eu:token`). A URL on any other host is the row warning `not_an_ats_url`; the row
  is skipped when it has no other board. A cell with an email address or phone number is
  refused. Row error codes: `missing_board`, `missing_provider`, `unknown_provider`,
  `missing_token`, `invalid_token`, `invalid_domain`, `contact_value`, `invalid_url`,
  `url_mismatch`, `malformed_row`. Row failure codes after the row is read: `board_not_live`,
  `board_unreachable`, `no_identity`. A second row
  with the same board key is `duplicate_row_key` (ignored, not failed). The board key uses the
  lowercased token, so tokens that differ only in case are one board. Messages never quote cell
  text.
- **Per row (OPS-1b order):**
  1. The board is already a source (keys compared ignoring case): its company, `unchanged`.
     When the row's domain names another company: a `careers_discovery` owner review. Nothing
     changes; the check runs before any link, so no company record changes.
  2. Domain match, then `ats` id match, then a unique exact name match when the row has no
     domain: the board is registered as a job source of that company (enabled, refresh every 6
     hours), through the same registration as `register_job_source`.
  3. A name match that cannot attach (several, or the domain matches nobody), or a domain and
     an `ats` id naming two companies: a `company_resolution` review (dedupe
     `company_resolution:ats_board:<observationId>`, actions merge, reject, dismiss). Nothing is
     registered.
  4. No match: one listing fetch through the adapter and the shared host limiter, scoped to the
     provider's API hosts. Live (HTTP 200 and a JSON listing that parses, 0 jobs included)
     registers the board first, owned by the company id `hash(board key)`, then creates that
     company (`ats` id, name from the row) with its creation audit event in one transaction,
     links the row to it and stores the listing as the board's first snapshot. Only the run
     whose claim holds the board creates, so no company exists without its board and no board
     gets two companies. A lost race decides the row again. Not live (404, 410, JSON that is not
     a listing) or unreachable (timeout, 5xx, 429, a non-JSON 200, an off-host redirect) fails
     the row; nothing is recorded or created and no review opens.
  5. A board source with no company is attached to the company of step 2 or 4, by a
     conditional update (only while it has none) that commits with its audit event
     `source.owner_changed`. A claimed board is registered with no schedule; it is scheduled
     only once its owner company exists (after the creation, or on attach).
  6. A row with no name and no domain whose board has no company: `no_identity`.
- **Evidence:** each accepted row is a company observation (parser `ats-board-directory-row@2`,
  external id `board:<key>`, payload `externalIds: [ats:<board key>]` and `ats { provider,
boardToken, region, apiBase }`). The link claims the `ats` id for the company in the link
  transaction. A created company has the id `hash(board key)`, so a replay finds it, and an
  audit event `company.created_from_ats_board`, one per board (details: board, observation,
  file source and snapshot, row locator, listing artifact). A board file source is always
  `third_party`; its rows are read as `third_party` evidence whatever tier is stored. Every ATS
  board source key (import and discovery) uses the lowercased token, and `POST /api/sources`
  finds an existing key ignoring case (200, `created: false`). Runs pinned to the first workflow version keep the
  M8.2 rules (attach only, parser `@1`).
- **File errors:** row errors or thrown row failures raise one `parser_failure` review for the
  snapshot. The `ats_board_import_report` artifact (errors, warnings, row failures) is written
  whenever the import has an error, a warning or a failed row.
- **Idempotent:** re-importing the same file registers nothing new and opens no new review.
- **Report:** the run output carries `importReport` (counts and trace). `created` = boards
  registered, `unchanged` = boards already registered to the same company, `updated` = 0.

## Sponsor registers (register adapters, M8.4)

A public sponsor register is one **register adapter** (`packages/market/src/sources/providers/registers/`),
registered as a Market source provider. The adapter declares everything register-specific; the
import workflow, the row step and finalisation are shared, so adding a register means adding one
adapter to `REGISTER_ADAPTERS` (the enum catalog reads the same list).

- **UK production path (v0.1):** the UK register stays on `market.uk_sponsor_register.import`
  (its M2 workflow, the scheduled path). `market.sponsor_register.import` also accepts the UK
  adapter (same row mapping, tested), but it is **not** the scheduled UK path; moving the UK
  source is a separate decision.
- **Extension limit:** "one adapter" holds for a register whose rows fit the shared shapes — a
  licence (`sponsorLicence`) or the H-1B-style history (`sponsorshipHistory`). A register with a
  new row or history shape (e.g. DOL LCA: occupation, wage, worksite) still needs a shared
  observation/schema change and reconciler support first.
- **Taxonomy-change risk:** reclassifying a route (e.g. a route moved from `labour` to `ignored`)
  must never turn its licences into `no_longer_listed` — that would claim a delisting that did
  not happen. Such a change ships with a policy bump and a reconcile that re-derives licences
  from the new taxonomy without delisting (follow-up M8.4b for the UK routes).

| Adapter field                       | Meaning                                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                | Register id, stored as `licences[].register` (`market.sponsorRegister`).                                                                                                                                                 |
| `provider`                          | The source `provider` that selects the adapter.                                                                                                                                                                          |
| `parse(bytes)`                      | Parser per file format, detected from the content (BOM-aware UTF-8/UTF-16; CSV/TSV/semicolon; HTML tables). An unknown format fails the run (`TerminalError`), never "0 rows".                                           |
| `routes[]` + `unlistedRouteMeaning` | Route taxonomy: each route has a canonical `label` (stored as `licences[].route`) and a meaning `labour \| history \| ignored` (`market.registerRouteMeaning`); a route not in the taxonomy gets `unlistedRouteMeaning`. |
| `identityNamespace`                 | Namespace of the identifier the register lists (`market.identityNamespace`), e.g. `nl_kvk`; null when it lists none.                                                                                                     |
| `evidenceTier`                      | `capability` (a listing: the company may sponsor) or `history` (past sponsorship activity) (`market.registerEvidenceTier`).                                                                                              |
| `scope.country`                     | The immigration system the register belongs to. Evidence applies to jobs in that country **only**; the row step refuses a mapping outside it.                                                                            |
| `publicationUrl`, `attribution`     | Default endpoint and the data's licence/attribution (below).                                                                                                                                                             |

Registered adapters:

| Provider (source `provider`)      | Register id                                | Workflow                                                                             | Scope | Tier       | Identity                                                                               | Unlisted route                                                 |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ | ----- | ---------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `uk_home_office_sponsor_register` | `uk_home_office_licensed_sponsors_workers` | `market.uk_sponsor_register.import` (M2, unchanged); the generic one also accepts it | GB    | capability | `uk_sponsor_register` (row key: name + town)                                           | `labour` (every route of the workers register, as before M8.4) |
| `nl_ind_recognised_sponsors`      | `nl_ind_recognised_sponsors`               | `market.sponsor_register.import`                                                     | NL    | capability | `nl_kvk` (KvK number) when listed, else the name rules                                 | `ignored`                                                      |
| `us_uscis_h1b_employer_data_hub`  | `us_uscis_h1b_employer_data_hub`           | `market.sponsor_register.import`                                                     | US    | history    | `us_h1b_employer` (employer name + state; the file has no usable id) — **attach-only** | `ignored`                                                      |

**`market.sponsor_register.import`** — nodes `locate` (`market.locate_register_download`: the run's
`url`, else the link the adapter finds on the publication page, else `endpoint.url`, else the
adapter's `publicationUrl`; skipped with `snapshotId`) → `download` (`market.acquire_snapshot`:
the SSRF-safe platform HTTP client; raw bytes stored as a content-addressed snapshot) → `parse`
(`market.parse_register_snapshot`) → `companies` (`core.for_each` of `market.process_register_row`)
→ `finalize` (`market.finalize_dataset_import`, the UK step: delisting and anomaly guard). Run
input `{ sourceId, snapshotId?, url? }`. The `parse` node output (run node view):

```ts
{
  register: string;             // adapter id
  format: 'csv' | 'tsv' | 'html_table';
  records: RecordSet;           // evidence rows only (JSONL)
  count: number;                // evidence rows = the dataset size the anomaly guard compares
  totalRows: number; skippedRows: number;   // file data rows; rows without a name or route
  routes: { route: string; id: string | null; meaning: 'labour' | 'history' | 'ignored'; rows: number }[];
  unlistedRoutes: string[];     // published routes the taxonomy does not know (id null)
}
```

Rules every adapter follows (they are enforced in the shared steps, not per adapter):

- A row on an `ignored` route never reaches the row step and is never evidence (no observation,
  no company). The per-route counts say what was dropped. An unlisted route of a register with a
  taxonomy is reported in `unlistedRoutes` (and logged) — add it to the taxonomy to use it.
- A capability listing becomes a company observation with `sponsorLicence { register, country =
scope.country, route = canonical label }`: company capability for jobs in that country only,
  never a role statement (`explicit_*` stay operator-only).
- Identity: a register-listed identifier becomes `externalIds[{ namespace, id }]` (normalised; a
  malformed value or one repeated digit — `00000000`, `11111111` — counts as absent). Namespaces
  have a `kind` (`companies/external-ids.ts`): `register_id` (`nl_kvk`: two different ids
  on one company contradict), `board_id` (`ats`, OPS-1b: the board key, `<provider>:<lowercased token>` or
  `<provider>:eu:<lowercased token>`, of a board the system fetched live; a company may hold several, they never contradict, and only
  the known board import sets it) or `row_identity` (`uk_sponsor_register`, `us_h1b_employer`: a row
  key, never an identifier — row keys never contradict, and a history row never attaches by its
  row key alone) and the identity key `ext:<namespace>:<id>`;
  without one, the row goes through the name rules every register row uses (exact legal name,
  review on doubt, never a fuzzy merge). The observation record key is `kvk:<id>|<routeId>` or
  `name:<strict key>|<routeId>` (NL), so re-imports are idempotent and a renamed sponsor with the
  same KvK supersedes its own observation (the old name stays as an alias).
- Delisting and the anomaly guard are the UK ones: only a healthy, complete import (not smaller
  than half the previous evidence-row count, ≤ 5 % failed rows) moves the complete-import marker
  (the snapshot's own fetch time); a licence absent from it becomes `no_longer_listed` (kept, with
  its evidence; capability `previously_licensed`). Otherwise a `source_anomaly` review (high) holds
  delisting back. Each source is its own dataset: register one source per published register page.
- Upload fallback: `POST /api/sources/:id/snapshots?process=true` with the file as `text/plain`,
  `text/csv`, `text/tab-separated-values` or `application/octet-stream` (the API does not take
  `text/html`; the parser sniffs HTML from the content). Processing is identical to a fetch.

### NL — IND public register of recognised sponsors (`nl_ind_recognised_sponsors`)

- **Source and attribution:** Immigratie- en Naturalisatiedienst (IND), "Openbaar register erkende
  referenten" / Public register of recognised sponsors, <https://ind.nl/en/public-register-recognised-sponsors>.
  Public government information (re-use under the Wet hergebruik overheidsinformatie); attribute
  "Source: IND public register of recognised sponsors (ind.nl)".
- **Published format:** one public register per residence purpose, each an HTML page with a table
  of **organisation name** and **KvK number** (Chamber of Commerce registration) under the
  register's heading; no town, no rating. Pages (English): regular labour and highly skilled
  migrants (`…/public-register-regular-labour-and-highly-skilled-migrants`, the adapter's default
  endpoint), research — Directive (EU) 2016/801 (`…/public-register-research-directive-eu-2016-801`),
  study, and au pair / exchange. The parser reads every table with an organisation column
  (`Organisation`/`Organisatie`/`Name`), the KvK column (`KvK number`/`KvK-nummer`/`Chamber of
Commerce …`) and takes the route from the table's **own** heading (Dutch or English): its
  `<caption>`, the `<figcaption>` of its figure or a bold-only paragraph directly before it
  (`<p><strong>Studie</strong></p>`), else the nearest heading before it when no other table
  shares that heading, else — on a single-table page only — the page's h1/title (without a
  site suffix such as " | IND"; it also stands in for a generic nearest heading such as
  "Recognised sponsors" / "Erkende referenten"). A table without a heading of its own (on a
  multi-table page, or sharing its nearest heading with another table) is fail-closed: its route is
  `(table without its own register heading)`, unlisted and ignored. Headings inside a table cell
  and `<template>`/`<script>` content never count;
  an operator CSV/TSV needs `Organisation`, optional `KvK number` and a `Category` (register) column.
  The live pages were **not reachable from the build environment** (egress policy), so the committed
  fixtures (`packages/market/fixtures/nl-ind/`) are synthetic samples of this documented shape; the
  parser fails the run on any page without such a table. Register sources: `nl-ind-labour` and
  `nl-ind-research` (one per labour page); the study and exchange pages need no source.
- **Route taxonomy (fail closed):** labour — "Regular labour and highly skilled migrants",
  "Researchers (Directive (EU) 2016/801)", "EU Blue Card" (when a register lists it), **only by an
  exact alias** (after dropping a "Public register"/"Openbaar register" prefix and a trailing
  directive reference, so "Openbaar register Onderzoek in de zin van richtlijn (EU) 2016/801",
  "Onderzoekers", "Kennismigranten en Europese blauwe kaart" are labour); ignored — "Study", "Au pair", "Exchange", "Seasonal labour", "Trainee" (e.g.
  "Stagiair arbeid in loondienst"), "Intra-corporate transferee", "Orientation year". A heading that
  matches no alias is ignored and listed in `unlistedRoutes`, even when it resembles a labour route
  ("Public register seasonal labour pilot", "Arbeid regulier (pilot)"): keywords only ever yield
  `ignored`. Goldens `nl-seasonal-labour-ignored`, `nl-seasonal-labour-pilot-ignored`,
  `nl-stagiair-ignored`, `nl-seizoensarbeid-ignored`, `nl-shared-heading-not-licensed`.
- **Default endpoint:** a source without `endpoint.url` fetches the labour register page
  (`NL_IND_LABOUR_REGISTER_URL`), never the register index; the research register needs its own
  source with `endpoint.url`.
- Semantics: an IND listing is NL capability only. It never implies UK or other-EU capability (an
  NL EU Blue Card listing is not a German one) and is never a role "yes" (golden
  `nl-licence-not-uk-role`).

### US — USCIS H-1B Employer Data Hub (`us_uscis_h1b_employer_data_hub`, M11.5)

- **Source and attribution:** U.S. Citizenship and Immigration Services, H-1B Employer Data Hub,
  <https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub> (U.S. government work,
  public domain); attribute "Source: U.S. Citizenship and Immigration Services, H-1B Employer
  Data Hub (uscis.gov)". One file per fiscal year: register one source and run it per file with
  `url` (or `endpoint.url`), or upload the file (`text/csv`, `text/tab-separated-values` or
  `application/octet-stream`). Category `signal_source` (it adds no companies).
- **Published formats** (detected from the header; comma or tab; UTF-8 or UTF-16 with BOM):
  legacy export `Fiscal Year, Employer, Initial Approval, Initial Denial, Continuing Approval,
Continuing Denial, NAICS, Tax ID, State, City, ZIP`; current "Employer Information" export
  `Line by line, Fiscal Year, Employer (Petitioner) Name, Tax ID, Industry (NAICS) Code, Petitioner
City, Petitioner State, Petitioner Zip Code` + approval/denial pairs for New Employment,
  Continuation, Change with Same Employer, New Concurrent, Change of Employer, Amended. Mapping of
  the current export: **initial = New Employment; continuing = the other five categories** (the
  legacy definitions). The public `Tax ID` holds the last four digits only; it identifies nothing
  and only tells rows apart. The live site was **not reachable from the build environment**
  (egress policy): the fixtures (`packages/market/fixtures/us-h1b/`) are synthetic samples of
  these shapes (legacy UTF-8 CSV; current UTF-16LE TSV; two malformed rows). The current-export
  mapping and encoding must be confirmed against a real file before the first production import.
- **Semantics — hiring history, never capability:** each row becomes a company observation with
  `sponsorshipHistory { register, country: US, route: H-1B, fiscalYear, initial/continuing
approvals/denials, state, city }` (no `sponsorLicence`; it contributes no names, locations or
  other identity facts). It feeds `company.employment.sponsorship.history[]` only, and job
  sponsorship `historical_evidence` for **US jobs only**. Never `company_capable`, never a job
  verdict, never `explicit_*`.
- **Row keys and parsing:** rows of one file with the same row key (fiscal year, employer, state,
  city, NAICS, ZIP, tax-id suffix) are summed; NAICS keeps otherwise identical rows apart. The
  stored record key (`externalId` `fy<year>|<hash>`) is a SHA-256 hash, so no tax-id or ZIP digits
  reach any API. A row whose cell count differs from the header's is skipped
  (`column_count_mismatch`), never read with shifted columns. An unknown state fails closed.
- **Attach-only resolution** (`resolution/history-attachment.ts`, DECISION_LOG "Sponsor register
  adapters" (2)): a row attaches only when, **at import time**, exactly one active company has the
  row's exact strict name key among its **own** names (legal, display, normalised — not an alias)
  **and** a known location (HQ, office, registered) in the row's state. `us_h1b_employer` is a
  row key: it is listed on the company but is not an identity key, and an earlier attachment
  (automatic or an operator's merge) is never proof for a later row — when a second same-name
  company appears in the state, the next row is reviewed. Ambiguous → an attach-only
  `company_resolution` review (`merge | reject | dismiss`, no `create_new`): the own name matches
  but the state is not known to agree (medium), several same-name companies (medium; high when
  several are in the state), alias only (low). A closed review re-raises for the next fiscal
  year's row. Everything else is skipped — no observation, no review, **never a company** — with
  a counted row outcome (`market_register_rows_total`): `skipped_legal_form_variant` (the name
  matches only without its legal form, e.g. "ACME LLC" vs "Acme Inc"), `skipped_no_exact_name`,
  `skipped_no_name`, `skipped_invalid_row` (no US state).
- **Unmatched rows** leave no observation: re-run the stored fiscal-year snapshots
  (`POST /api/snapshots/:id/reprocess`) after the company base grows (e.g. a directory import adds
  US locations) to re-evaluate them.
- **Supersession and finalisation** (DECISION_LOG "Sponsor register adapters" (3), delta review
  B-M1/B-M2/L3): the latest complete import of a fiscal year replaces **that source's** earlier
  rows of the year (`source.health.historyPeriods[] { period, completeAt, rowCount, snapshotId,
parser }`; the marker only moves forward). Replacement is destructive, so each fiscal year has
  its own shrink guard (one ratio, 0.5): the **parse step** decides per year against the marker it
  read (`periods[] { period, rows, heldBack, confirmed, previousRows, marker }`; a held year's rows
  are not processed) and **finalisation applies exactly that decision** with a compare-and-set on
  that marker. A marker that moved in between (an overlapping import of the year finished first)
  applies nothing for the year and raises a `source_anomaly` ("marker moved"). A snapshot older
  than the marker never moves it (reprocessing an older file changes nothing). Re-reading the
  marker's own snapshot with another parser version is guarded like a new file. A held year raises
  its own `source_anomaly` (context `{ period, count, previousRows }`, one per year, snapshot and
  baseline): **`confirm` accepts exactly that shrink** — the next run of that snapshot applies it;
  `retry` alone keeps it held. The failure-ratio guard holds back every year. There is no
  dataset-wide shrink guard and no delisting. Re-importing an identical file changes nothing.
  Residual: rows processed by a run whose year was not applied (failure ratio over the limit, a
  moved marker, a crash before finalisation) count beside the year's previous rows until the next
  complete import of that year — re-run the import.
- **Sole proprietors:** employer names are business identifiers only; they are never linked to
  Professional subjects (people), as for the directory import.
- **Not included:** DOL LCA disclosures (M11.5 remainder).

## Changelog

- **v2.6 (OPS-1b):** known board file: `provider` and `token` are optional when `url` is mapped
  (derived on the server); new row warning `not_an_ats_url`, row error `missing_board`, row
  failures `board_not_live`, `board_unreachable`, `no_identity`. A row with no matching company
  is fetched once and, when the board is live, creates a board-anchored company with the new
  external-id namespace `ats` (the board key, region included: `greenhouse:eu:acme`). Ashby
  tokens may hold single spaces (percent-decoded). A board file source refuses any tier but
  `third_party`. Workflow steps `map_ats_board_directory@2`,
  `process_ats_board_row@2`, `finalize_ats_board_import@2` (the `@1` steps stay for pinned runs).
  Imports report `warnings` for board files, and every import with warnings or failures links
  its report artifact. Additive for clients except the Admin mapping form (see
  `market-imports.md`).

- **v2.5 (OPS-1):** provider `ats_board_directory` and workflow `market.ats_boards.import`
  (M8.2, above). Source list rows and `source` in the detail carry `schedule` state
  (`nextRunAt`, `lastFiredAt`, `enabled`, plus the config fields) or `null`. The company
  directory run output adds `importReport` (counts and trace) and queues careers discovery for
  the companies it created or changed. `system:careers-discovery` runs hourly. Additive for
  existing sources.
  OPS-1 repair: `schedule` is `null` when the source has no schedule or no scheduler entry. Boot
  seeds the `system:careers-discovery` schedule once (label `system-schedule-seeded`). New index
  `by_key_ci` (case-insensitive key lookup for board files). Config-level `personal_data_column`
  problems name the configured column; header problems add `position`.
- **v2.4 (M8.1, PR #27):** provider `company_directory` (above). Additive for existing sources.
  `authority.tier` is optional on register only for `company_directory` (defaults to
  `third_party`); every other provider still requires it (400). `POST /api/workflows/<key>/runs`
  with a directory `sourceId` is 400 for any workflow other than
  `market.company_directory.import` or without `snapshotId`. Company name keys are
  `name-norm/2` (Unicode-aware; Latin keys unchanged; v1 keys still matched and backfilled
  additively) and the resolver is `company-resolver/2` (bare directory names go to review).
  Hardening (PR #27 re-verification #2): one domain refusal list incl. Website / Careers hosts,
  placeholders absent, `contact_value` (renamed from `contact_value_in_company_field`) for every
  kept cell, website = scheme + host, row errors without cell text (`duplicate_row_key` names the
  first row; processing failures carry `code: processing_failed`), the tokenised header guard,
  Companies House prefixes, no schedule for upload-only sources. Structural identity (PR #27
  re-verification #3): only the Domain column is domain identity (Website is an attribute),
  domain / id hits need the row's own name key, legacy name keys go to review,
  `conflicting_external_id`, all-zero-only placeholder ids, careers URLs without query/fragment,
  unmapped and personal columns named by position in the 400 body. Contradicting evidence (PR #27
  re-verification #4): bare = no register id and no Domain; directory matches refused on a
  register-id contradiction (high), a country disagreement, alias-only or name-less hits;
  same-name different-id rows in one file go to review; the reconciler records two ids in one
  single-valued namespace as a conflict (`company-policy/2`); contact-link hosts and phone-shaped
  path segments; header guard additions; `RegAddress.CareOf` refused. Privacy and concurrency
  (PR #27 re-verification #5): `ignoreColumns` removed; structural contact detection (9+ digits
  across non-letters, any `@`-like, `at`/`#` + registrable domain, no digits in towns,
  `invalid_town`); the file id is stored only as a SHA-256; creating writes hold the candidate's
  ids and HQ country; ids that found nothing never attach by name to a company with ids in other
  registers; bare-review dedupe by country and legal name; id-conflict reviews refresh, resolve
  and honour dismissals; `duns` and Companies House BR numbers multi-valued; the no-identity-column
  upload/report warning (`warnings[]` in the upload response); register ids normalised for every
  provider. Residual bar and drop-vs-refuse (PR #27 re-verification #6):
  the standard email notations (HTML entities and percent-escapes decoded; at tokens in every
  bracket form with `.`, `[.]`, `(.)`, `.` or `dot` domains; `arroba`); documented residuals;
  optional-cell problems drop the cell with a row warning (`rowWarnings[]`), only the name cell
  refuses the row; register ids normalised before contact checks; numbered-company names (ACN,
  Quebec); careers URLs on profile hosts dropped; BR numbers contradict any non-FC company number;
  stale `ext:` keys released; a dismissal closes the review whenever the set matches any dismissed
  set; the file-id hash is not case-folded; the seeded HQ country only from an HQ or registered
  office. Key release fenced; no numbered-company exemptions (PR #27 re-verification #7, ruling
  c1a3500): stale `ext:` keys released only inside the revision-guarded commit and only for keys
  of superseded observations (never creation-seeded or current keys), the `ext:`
  backstop always on; atomic bracketed at tokens, `[ . ]`/`<dot>` separators and any public
  suffix after a spelled `dot`; the ACN/Quebec exemptions removed; `defaultCountry` only for an empty cell;
  LinkedIn job ids, normalised profile paths and more profile hosts; the in-file id check uses
  `idsContradict`; dismissals cover subsets; the review text names only existing actions. No
  exemptions (PR #27 re-verification #8, ruling 621f14c): the legal-form exemption removed (names
  like "Tea at Polka dot Ltd" a documented over-refusal); URL paths scanned raw first, only a
  trailing LinkedIn-shaped id set aside; the name digit rule exactly 9+ digits (Quebec numbered
  companies kept; 7-digit local numbers a documented residual); linking or superseding an
  observation advances the company revision (the release fence); the release query counts
  superseded observations only; a stale key waits for that company's next reconciliation.
  Re-verification #9: URL cells and hosts decoded and scanned (an `@`-like character, contact
  values, 9+ host digits); any separator around a spelled `dot`; tighter LinkedIn id shapes; the
  link and the rev bump in one transaction, which claims the observation's register-id keys,
  follows a merged target to its survivor and bumps active companies only; the measured cost.
  Re-verification #10 (ruling af1b342): contact detection is one tokeniser-based grammar matcher
  (brackets are separators; two hyphen tokenisations; hyphen-joined tails; public suffixes incl.
  punycode) applied to the decoded, zero-width-stripped and zero-width-as-space text and to the
  name keys, with a generated cross-product test suite; URL cells also scan the raw path before
  URL parsing normalises dot segments; a link contradicting a held single-valued id aborts to a
  high review; the markCurrent fence includes this version's company whenever it is resolved.
  Re-verification #11: dot-forms beside dots between labels; `(a)` in Unicode brackets; linear
  label chains (253 characters / 127 labels) and an in-place tokeniser with a perf bound; the
  seeded fuzz suite; backslash paths; a forced last resolve pass after a contradiction; the
  40-way in-process fan-out race test; "X at Y. Co" names and `/at/…` TLD-like file paths as
  documented over-refusals. Re-verification #12: keywords as local parts and labels; paired
  brackets and quote pairs for `(a)`; the host's last label scanned with the raw path and
  ICANN-registrable Domain, Website and Careers hosts; zero-padded entities; handle-shaped
  handles; default-ignorable code points and orphan marks; `-` as no link boundary; the dead
  `EMAIL` regex removed; the map yields and heartbeats; the measured throughput.
  Re-verification #13 (ruling 6bff30e — detection fails closed): at-forms in Website / Careers
  hosts and paths drop the cell; the search budget counts cost and fails closed
  (`contact_value_undecidable` for a name); invalid labels prune a chain; the adversarial
  corpus perf bound (≤ 50 ms per row); `throwIfAborted` at every map pause; handle refinements;
  dot words `punto`/`punkt`/`point`/`ponto` and `·`/`‧`/`•`; `Bidi_Paired_Bracket` pairing plus
  any-quote pairs; trailing-dot hosts; the orphan-mark test. Amended (supervisor): an at-form
  that is only the public suffix (`.at`) drops a URL cell only before a domain-shaped path or
  query (or an undecided search).
  Re-verification #14 (ruling 29b6592): Website / Careers URL cells are reduced, not parsed —
  split as written, the query and fragment never stored, a path kept only when plain, otherwise
  the origin with `url_reduced_to_origin`; host at-forms fail closed (`at.com`, `www.at.at`
  dropped); the path/query special cases (raw-rest scan, last-host-label scan, `.at` query
  rule) removed. Hyphen cuts are tried before any label-length prune, and labels are measured
  in punycode. Handle exemptions narrowed to single letters, versions, legal forms, `No`/`Nr`
  before digits and `St`/`Mt` before a capitalised word. A hill-climbed all-columns perf corpus
  pinned at ≤ 100 ms per row.
  Re-verification #15 (ruling bd6ad44 — check what you store): the full detector (at-words on)
  runs on the stored URL / domain and both forms of its host (punycode, Unicode); the serialised host must be the written one; invisible code points drop URL cells (raw,
  percent- and entity-decoded); IDNA and PSL primitives memoised and charged to the budget, with
  a 3 × 63 code-point bound before `domainToASCII`; path-based domain-identity refusals on the raw
  Domain / Website cell; the rv15 shape and a CI bounded hill-climb in the perf suite; `v2.0`,
  `E.ON` and `Nr.Five` after a messaging word kept.
  Re-verification #16 (ruling 64d97b4 — one canonical form): text cells canonicalised (decoded,
  NFKC, invisible code points spaced, to a fixed point, whitespace collapsed) and checked, stored
  and keyed in that form, the written form checked too, `value_normalised` for a kept changed
  cell; skeleton readings (marks removed; outside letters/digits/ASCII punctuation spaced, or
  non-ASCII symbols removed); handle exemptions back to 29b6592 (3) plus `v` versions and an
  acronym before a legal form (`Nr.Five`, `TOM.LEE` refused); Country cells over 64 characters
  `invalid_country`; bare-host Domain cells; map, search, cache, translation, archive and
  shortener hosts never identity; the derived website checked; cold-cache perf with the rv16
  Country shape; the 3 × 63 IDNA bound pinned.
  Re-verification #17 (ruling d232db7 — a true, bounded fixed point): well-formed text (lone
  surrogates → U+FFFD, as BSON stores them) before any check; `canonicalText` iterates until
  unchanged, undecidable after 64 rounds; the length limit on the canonical form (NFKC expansion);
  every token after a platform word examined, label words skipped, separators widened, the
  acronym exemption void after a platform word; the Website Google path decoded and
  `//`-collapsed; Google `images`/`lens`/`news`/`scholar`/`books`/`shopping` and `mapquest.com`
  shared; U+FDFA in the perf corpus; the 3 × 63 bound pinned with decomposed Hangul.
  Re-verification #18 (ruling 47c0f5c): the handle rule is a text-cell rule (URL and Domain cells
  never scanned for handles); every token before and after a platform word; company-domain,
  abbreviation, legal-form and digit exemptions (one documented list each); whole-token
  `St`/`No`; more dot-like joiners; `kik`, `threema`, `kakao`, `twitter` as platform words; a
  structural per-row work budget with per-row memos; more map and search hosts shared.
  Re-verification #19 (ruling ed7b71a, amending 47c0f5c): the domain exemption is self-reference
  only (TLD surnames refused); a platform word in a URL path, query or fragment reduces it to its
  origin; 7+ digit runs next to a platform word; joiner runs, `<alnum>:<alnum>` pairs, `٫` `۔`;
  registry markers; more legal-form parts (`Sp.z o.o.`, `Ges.m.b.H.`, `Cía.Ltda.`, …); the
  per-row memo is row-scoped (a row's charge never depends on earlier rows) and the handle rule
  is charged; the self-reference search is linear.

- **M11.5 (v2.3)**: US H-1B Employer Data Hub adapter (hiring history, attach-only, above);
  history registers replace rows per (source, fiscal year) with a per-year shrink guard decided by
  the parse step (`periods`), applied by `market.finalize_dataset_import` with a compare-and-set
  on each year's marker; an operator `confirm` of a held year's review accepts it; no delisting.

- **M8.4 (v2.2)**: register adapters and `market.sponsor_register.import` (above); provider
  `nl_ind_recognised_sponsors`. The UK import and its outputs are unchanged.

- **PR #11 final check**: a failed run counts once in `health.consecutiveFailures` however often
  it is retried and whatever ran in between (`health.failedRuns`: the current streak's run ids,
  latest 20, cleared by a success). Jobs whose re-derivation fails are kept in
  `market_job_lifecycle_failures` (one document per job) instead of a list on the sweep's
  watermark document.

- **PR #11 re-verify #12**: `health.consecutiveFailures` is kept by the latest-fetch record
  itself (a newer successful fetch resets it, a newer failed one adds one, a retried failure of
  the same run counts once), so a success finalized after newer failures no longer leaves a
  streak counted from before it; `health.latestFetch` gains `runId`. The freshness workflow has a
  separate `evidence` node (`market.sweep_recorded_evidence`, output `{ evidence, jobs, written,
complete, lagMs, retried, failing }`); `freshness_sweep` no longer reports
  `rederivedFromEvidence`. Standing recomputes left pending are resumed least recently attempted
  first (`standingRecompute.lastAttemptAt`), within a 4-minute slice. Finalize `absent` /
  `alreadyApplied` count open jobs only (a CLOSED job's absence is recorded as evidence, not
  counted).

- **PR #11 re-verify #11**: source health follows the latest fetch on every path (ATS fetch and
  parse failures, finalize, uploads, careers crawls): a run's success or failure changes `health`
  only while its fetch is still `health.latestFetch` (run `stats` still count once per run), so an
  older run finishing after a newer failure never reports the source healthy. The freshness sweep
  resumes each pending standing recompute in isolation (own time budget; a failure is logged and
  retried by a later sweep, never blocking the other sources) and reports
  `rederivedFromEvidence` (jobs re-derived from newly recorded evidence).

- **PR #11 re-verify #10** (DECISION_LOG 9b0cb03): new `standingRecompute { pendingAt, cursor }`,
  written in the same update as each `standingHistory` entry and removed once the source's jobs
  are re-derived; while present, a retry of the same enable/disable re-enqueues the run, and the
  freshness sweep resumes it after 15 minutes (`resumedStandingRecomputes` in its output). The run
  skips `CLOSED` jobs, saves its cursor after each page and stops on cancellation, so it never
  restarts from the top. A `standingHistory` entry is always strictly later than the one before
  (a clock step back is clamped). Careers crawls label their sightings with the run's start time
  and the crawl's start URL; the extract step is declared with its side effects, and a re-run of
  an older crawl never moves `health.latestFetch` or health over a newer failure.

- **PR #11 re-verify #9** (DECISION_LOG 15c965b): new `standingHistory [{ at, enabled }]`, appended
  in the same write as every enable/disable (seeded with the state before the first change). Jobs'
  lifecycles evaluate the source's standing as of each piece of evidence, so enable/disable never
  rewrites a job's past. A change starts `market.source.recompute_jobs` (labelled
  `standingOfSource`, idempotent per change; setting the current value does nothing). Tier and
  provider remain immutable. The first processing of an uploaded snapshot is its acquisition;
  reprocessing it later never changes health. Careers crawls record their sightings at the
  crawl's own time, on the endpoint read at crawl time.

- **PR #11 re-verify #8** (DECISION_LOG 6a01b36): new `health.latestFetch { at, ok }` — the latest
  REAL acquisition of the listing (a fetch or an upload); reprocessing a stored snapshot never
  changes source health (no `recordSuccess`/`recordFailure`, no `latestFetch`), so it cannot clear
  "latest listing failed". Snapshots record `fetchBoard` (the endpoint when their fetch started;
  an upload: the endpoint at upload); reprocessing records evidence on that board. The board a
  listing is read from is captured at fetch start: an endpoint `PATCH` while a listing is in
  flight never relabels what it read. A listing finalized after its source was disabled records
  no absences. Disabling a source takes its evidence out of every job's derived lifecycle
  (superseded in re-verify #9: standing is evaluated as of the evidence time).

- **PR #11 re-verify #7**: job-source providers are a closed, case-normalised set
  (`JOB_SOURCE_PROVIDERS`): `POST /api/sources` trims and lower-cases `provider` and refuses a
  `job_source` provider outside the set (400). Stored sources are not migrated: a job source
  whose stored provider is outside the set is read as stored, its copies are never
  authoritative, and it is reported in the start-up log ("job sources with a provider outside
  the supported set"). New optional field `endpointChangedAt`: set by a `PATCH` that changes
  `endpoint`. After an endpoint change, jobs seen before it are not verified (inconclusive)
  until a listing on the new endpoint shows them; while the source's latest listing fetch has
  failed (`health.lastFailureAt` ≥ `health.lastSuccessAt`) none of its copies is verified. A
  mistyped endpoint therefore changes no job state; fix it with another `PATCH`.
