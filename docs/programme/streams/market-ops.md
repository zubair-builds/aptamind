# Market Ops — Market Intelligence operationally complete v1

Owner priority from 2026-10-01 (DECISION_LOG, `O` rows of that date). This file is the working
brief. `streams/market.md` keeps the milestone history (M6–M12); this file says what runs next and
in which order. Where the two conflict, this file wins.

## Goal

Selected real sources run on their own and keep the canonical Market database current. No Claude
session is needed to fetch anything. Claude builds the machinery; the machinery fetches the data.

The canonical data created now is MVP data. It keeps the same contracts, IDs, provenance and
history all the way to the MVP. Only the physical Mongo deployment may move.

## Audit summary (2026-10-01, `main` c72a94d)

What already works:

- Greenhouse, Ashby and Lever adapters fetch real data through `SafeHttpClient`
  (`pnpm smoke:live`: Greenhouse 713 Stripe jobs and Ashby verified live from the owner's Mac;
  Lever timed out once on a large board).
- Lifecycle states DISCOVERED, VERIFIED_LIVE, CHANGED, POSSIBLY_STALE, CLOSED, REOPENED, REPOSTED
  and the listing shrink guard (`jobs/listing-policy.ts`).
- Source health fields on `market_sources`; schedules in `workflow_schedules` fired by the worker.
- Snapshots are content-addressed; `recordSnapshot` knows when content is unchanged.
- Company CSV import (`market.company_directory.import`, M8.1) and careers/ATS discovery
  (`market.company.discover_careers`).

Gaps this programme closes:

| Gap                                                                       | Where it is fixed |
| ------------------------------------------------------------------------- | ----------------- |
| `HostRateLimiter` is per process; N workers multiply the per-host budget  | FE-2              |
| No Retry-After handling, no shared host cool-down                         | FE-2              |
| No ETag / Last-Modified requests                                          | OPS-2             |
| Unchanged content still runs parse, normalize and interpretation          | OPS-2             |
| Interval schedules fire in phase (cron storms); no per-source spread      | OPS-2             |
| Failing sources do not back off (M10.3)                                   | OPS-2             |
| No top-level Imports; no import record                                    | OPS-1 + ADM-1     |
| Known ATS board import (M8.2) missing                                     | OPS-1             |
| Careers discovery is never scheduled and does not follow a company import | OPS-1             |
| `nextRunAt` not shown with source health                                  | OPS-1             |
| No signal writers (`market_signals` is a schema only)                     | OPS-4             |
| No retention metadata on artifacts                                        | OPS-3             |
| Job URL imports (wave 2)                                                  | OPS-5             |

## Work graph

```text
P0-A docs (this file, contracts, state)  ──► FE-2 limiter ──► OPS-2 acquisition efficiency
                                          ├─► OPS-1 imports API + M8.2 + discovery ──► ADM-1 /imports UI
                                          └─► ADM-1 (against the contract, in parallel)
OPS-1 + ADM-1 + OPS-2 ──► P0-E manual test ──► waves 3-5 live (GH, Ashby, Lever) ──► MKT-OPS-1
MKT-OPS-1 ──► OPS-3 retention ─► OPS-4 signals ─► OPS-5 job URL import ─► waves 6..17
```

| Id    | Branch                         | Owner area                                      | Scope                                                                                                                                                                                                                                                                                                                                |
| ----- | ------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FE-2  | `foundation/fe-2-host-limiter` | `packages/net`, `packages/config`, platform     | Limiter seam on `SafeHttpClient`; Redis-backed shared per-host limiter (concurrency + spacing + lease expiry); shared host cool-down from Retry-After; `retryAfterMs` on responses and `HttpError`; config switch. Record: `foundation-exceptions/FE-2-distributed-host-limiter.md`.                                                 |
| OPS-1 | `market/ops-1-imports`         | `packages/market`, Market API routes            | `market_imports` record and `/api/imports` (contract `market-imports.md`); M8.2 known-board import; discovery after a company import; discovery batch on a schedule; `nextRunAt` in source health.                                                                                                                                   |
| ADM-1 | `admin/adm-1-imports`          | `apps/admin`                                    | `/imports`, `/imports/new/<type>`, `/imports/[id]`; browser-side preview and column mapping; generic snapshot upload moved behind "Advanced".                                                                                                                                                                                        |
| OPS-2 | `market/ops-2-efficiency`      | `packages/market`                               | Conditional requests (ETag/Last-Modified stored on source health); unchanged listing stops parse/interpret but still confirms presence; deterministic per-source schedule spread (cron offset from the source id); source backoff ×2 capped at 24 h, and a `source_anomaly` review after repeated 404 (M10.3); use FE-2 Retry-After. |
| OPS-3 | `market/ops-3-retention`       | `packages/market` (+ FE if the store must grow) | `retentionClass`, `expiresAt`, `pinned` on Market snapshots; an expiry sweep that never deletes evidence referenced by an open review or a current fact.                                                                                                                                                                             |
| OPS-4 | `market/ops-4-signals`         | `packages/market`                               | Signal writers for the raw vocabulary from lifecycle transitions and canonical changes, each with evidence ids.                                                                                                                                                                                                                      |
| OPS-5 | `market/ops-5-job-urls`        | `packages/market`, Admin                        | Job URL / job CSV import: URL → provider detection → company resolution → source registration → canonical job.                                                                                                                                                                                                                       |

At most three heavy agents run at once. One agent owns one area at a time.

## Decisions taken here (supervisor)

- **Schedule spread without a Foundation change.** An interval source gets a cron expression with a
  minute and hour offset derived from a hash of its source id (for example `37 1-23/6 * * *` for
  6 h). Sources stay spread for ever and the spread is stable across restarts. The scheduler is
  unchanged. Real jitter in `packages/workflows` waits until this proves insufficient.
- **Import preview and mapping happen in the browser.** The Admin reads the file locally, shows
  the header and sample rows, lets the operator map or drop columns, then uploads a CSV that
  contains only mapped columns. Unmapped columns (notes, personal data) never reach the server.
  The M8.1 rule "every column of an accepted file is mapped" stays true on the server, and the
  server still runs every check. The import record keeps the original file name.
- **R2 needs no code change.** See "Storage" below.
- **Retention is application-controlled.** Artifact keys are content addresses shared by every
  snapshot with the same bytes, so a bucket lifecycle rule by prefix cannot know if a key is still
  referenced. Expiry is a sweep over Market snapshots that checks references first (OPS-3).

## Storage (P0-B)

The S3 adapter (`packages/storage/src/object-storage.ts`) works with Cloudflare R2 unchanged.
Values for R2:

```bash
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=aptamind-artifacts          # create it in the Cloudflare dashboard first
S3_ACCESS_KEY_ID=<R2 API token access key id>
S3_SECRET_ACCESS_KEY=<R2 API token secret>
S3_FORCE_PATH_STYLE=true              # R2 accepts path style
```

- Create the bucket in Cloudflare first. The token needs "Object Read & Write" on that bucket only.
  On boot the adapter calls HeadBucket and, if that fails, CreateBucket; a bucket-scoped token
  cannot create buckets, so the failure is only logged. That is fine when the bucket exists.
- If R2 ever rejects the SDK's default CRC32 checksum headers, set
  `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` and `AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`
  in the environment. The AWS SDK reads these itself; no code change.
- Local fallback: `pnpm infra:up` starts SeaweedFS on `127.0.0.1:9000` with the defaults in
  `.env.example`. Nothing else changes between the two.

## Source Definition of Done

A source is done only when all of these hold, verified on real data:

1. Real external data fetched; governance and access policy recorded on the source.
2. Rate limit applied through the shared limiter; retry with backoff; Retry-After honoured.
3. Content hash recorded; an unchanged payload stops downstream processing.
4. Raw artifact retention follows the retention policy.
5. Observations created; entity resolution and reconciliation update canonical records with
   provenance.
6. A second identical run is safe (idempotent); a changed payload is applied; removals and
   closures follow the lifecycle policy; an abnormal shrink or partial parse never closes jobs.
7. A schedule exists and fired on its own at least once; health is visible in Admin.
8. Ambiguity reaches review; the targeted local gate is green.

Then the source is marked done in `PROGRAMME_STATE.yaml` (`market_ops.sources`).

## Source waves

1 owner company lists · 2 owner job lists/URLs · 3 Greenhouse · 4 Ashby · 5 Lever · 6 generic
careers · 7 UK sponsor register · 8 NL IND (real-file gate) · 9 USCIS H-1B · 10 DOL LCA · 11 YC /
Work at a Startup · 12 a16z · 13 Techstars · 14 RemoteOK · 15 We Work Remotely · 16 SEC Form D ·
17 official company news/RSS. One wave is verified before the next starts.

## MKT-OPS-1 exit criteria

Local Mongo/Redis/API/worker/Admin running; storage ready for R2 with the local fallback;
`/imports` usable; a real company file imported from Admin through the normal resolution path;
careers discovery runs; Greenhouse, Ashby and Lever operational on real data; schedules fire on
their own and a second run is idempotent; new, changed and removed jobs behave correctly; source
health visible; the owner has the manual test guide (`docs/runbooks/market-ops-manual-test.md`).

## OPS-2 implementation notes

- **Conditional fetch.** `market.fetch_job_board@3` sends `If-None-Match` and `If-Modified-Since` from the
  source's listing stamp (`health.listingStamp`). A 304 reuses the stamped snapshot.
- **Unchanged-listing short-circuit.** When the content hash matches the stamp (or on a 304), fetch
  parses only the presence keys. If every listed id is a present copy of an active job, the run takes
  the `confirm` path: no per-job ingest, and finalize records `present` evidence so jobs stay `VERIFIED_LIVE`
  and their verification time moves on. Anything else takes the full path.
- **Stamp rule.** Finalize writes the stamp only for a clean, complete, applied listing with no failed
  items. A held (shrink) or partial listing clears it, so those always run the full path.
- **Copies digest.** The stamp also keeps `copies`: a SHA-256 of the sorted (copy key, content hash,
  last observation id) triples of the listed copies, read when finalize writes the stamp. The
  observation id covers fields the content hash ignores (title case, apply URL, requisition id). It
  hashes the full payload, so confirm runs, which write no observation, keep it stable. Fetch takes the confirm path only
  when the current copies give the same digest. On the confirm path finalize reads the digest again
  after confirming presence. If another run ingested other bytes in between, it clears the stamp and
  the next run is full. A confirm never writes content, so it cannot repair that copy itself.
- **Workflow shape.** `fetch → route (core.switch) → ingest → finalize`. On the confirm path fetch
  returns an empty `records` set (ingest does no work) and the listed ids in `present`. A `deferred`
  fetch ends the run at `route`. A replayed finalize ("already applied") leaves the stamp as its
  first execution wrote it.
- **Schedule spread.** `SourceService.register` and `update` add a cron for ATS interval schedules. The
  minute and hour offset come from a hash of the source id (`spreadCron`). `spreadAtsSchedules` runs on
  start-up; it updates the scheduler first, then the source, and is a no-op on a second run.
- **Backoff.** Only a run that failed for good sets `health.backoffUntil`: a terminal error, a
  `Retry-After` over 60 s, or the last fetch attempt (`FETCH_RETRY.maxAttempts`, counted per operator
  retry). It is the slot plus interval × 2^failures, capped at 24 h, or the `Retry-After` when that is
  later. The first attempt of a scheduled run inside the window returns `deferred` without a request.
  Retries, operator retries and manual runs are never deferred, so a failed run ends `FAILED`. A
  success clears it.
- **Host cool-down.** When the net client refuses to send because the provider host is cooling down
  (another board's `Retry-After`) or no request slot freed up in time, fetch returns `deferred` with
  `deferredReason: 'host_cooling_down'`. It records no attempt, failure or backoff on the source.
  Foundation marks this only as a status-less `HttpError`, so Market recognises it by that shape.
  This applies to the first attempt only. A later attempt follows a failed request of this board,
  so it ends the run `FAILED` (terminal, no backoff) instead of hiding that failure as `deferred`.
- **Not found.** Three consecutive 404s open one `source_anomaly` review (`board_not_found`). The
  source stays enabled. `health.notFoundRuns` keeps only the last three runs. The review opens only
  when a run is newly added as the third of its streak.
- **Schedule view.** `schedule.backoffUntil` shows an active backoff. `schedule.nextRunAt` is then the
  later of the next fire and `backoffUntil`.
- **Migration safety.** `spreadAtsSchedules` re-reads each source before it syncs, and syncs again when
  an operator enabled or disabled it during the upsert. Accepted trade-off: the scheduler upsert
  computes the next fire from now, so a fire that is due when the migration runs moves to the next
  cron slot. That delays it by at most one interval, once per source, at the deploy that first runs
  the migration. Market never writes the `workflow_schedules` collection itself.
- **Known Foundation follow-up.** A scheduler port option to keep a due fire on upsert. With it, the
  migration (and any schedule change) could keep a due fire due.
- **Known Foundation follow-up.** The net client forwards request headers, including
  `If-None-Match` and `If-Modified-Since`, on redirect hops to any host. A redirect to another host
  should drop them. Foundation is frozen in this lane, so this is left for a Foundation change.
- **Known limit: last attempt.** Fetch finds its last attempt as `attempt % FETCH_RETRY.maxAttempts
=== 0`. The runtime budget also adds lost-acknowledgement retries (`ackRetries`), and the capability
  context does not expose the budget. After such a retry the backoff can be written one attempt early,
  or not at all if the extra attempt fails. Fixing it needs a Foundation change (expose the budget or
  a "last attempt" flag on the context). This lane leaves Foundation frozen.
- **Known limit: CHANGED marker.** A late ingest of an older fetch can land after a newer one. The
  lifecycle `CHANGED` marker of the newer content can then be lost, though the content and evidence
  stay correct.
- **Known limit: redirect hop.** If the board redirects and the client refuses a busy host on hop 2,
  hop 1 was already sent. Fetch cannot tell (Foundation reports both as the same error), so it still
  defers on the first attempt and records no attempt. The next fire tries again.
- **Admin follow-up.** A manual "Run now" on a source whose host is cooling down ends `COMPLETED`
  with path `deferred` and only `deferredReason: 'host_cooling_down'` in the fetch output. Admin must
  show that reason, or the operator sees a run that did nothing.
- **Discovery.** `register_job_source@2` looks the board up by a lowercased key, ignoring case. A board
  owned by another company raises an owner review and registers nothing.

## OPS-3 retention (implemented 2026-10-30)

- Policy `retention/1` (`packages/market/src/retention/policy.ts`): `web_snapshot` 30 d,
  `register_snapshot` 365 d (source authority `official_registry`), `import_file` 90 d (uploads,
  `manual_import` sources), `review_evidence` 180 d. Each fetch of the same bytes extends `expiresAt`.
- `market.retention.sweep` (daily) backfills legacy snapshots, then for each snapshot past expiry
  holds it (extending expiry, recording `retentionHold`) when it is the latest snapshot of its
  source, is cited by an open review item, produced a current (non-superseded) observation, is
  cited by `market_job_evidence.snapshotId` or signal evidence, or is named on canonical company
  or job fact evidence (including a legacy job `listingMarks` entry); otherwise sets `expiredAt`.
  After that write the sweep reads the hold again and clears `expiredAt` if a citation appeared
  in between. Pinned snapshots never expire. Records and observations stay, so evidence
  references never dangle. Released bytes are deleted by the FE-4 purge node on the same
  workflow (see below). The purge re-checks `holdReason` for every snapshot sharing the artifact
  immediately before delete, so a reverted release blocks deletion, as does any current hold
  (including job evidence, signal evidence and canonical fact). A citation that lands after
  that immediate check can still drop bytes (residual race).
  `market_snapshots.by_expires` is a plain `{expiresAt:1}` index (`$exists: false` is not a legal
  partial filter). Observation `by_snapshot` indexes are partial on `snapshotId` existing.
  `by_artifact` and partial `by_released` serve the purge.

## OPS-4 signals — lifecycle part (implemented 2026-10-30)

- `LifecycleSignalWriter` (`packages/market/src/signals/lifecycle-signals.ts`, writer `lifecycle/1`)
  and the hourly `market.signals.lifecycle` workflow. Progress is a stored `(updatedAt, _id)`
  watermark in `market_signal_writer_cursors` (`_id: lifecycle`), advanced only over jobs the pass
  scanned. The next run continues after it. Jobs in the 2 h before that watermark are re-read
  (dedupe keys make the overlap a no-op); that re-read does not move the watermark or consume
  `maxJobs`. Each lifecycle history entry whose target is DISCOVERED, CHANGED, CLOSED, REOPENED
  or REPOSTED and that names a source becomes one `job_*` signal. The first history entry, when it
  is a sourced `VERIFIED_LIVE` (an authoritative ATS first sighting; there is no `DISCOVERED`),
  is `job_discovered`. Id and dedupe key are deterministic (job, target state, transition time).
- Evidence: the `market_job_evidence` records of the same job, source and time (ids in
  `facts.evidenceIds`, snapshot ids in `evidence[]`); confidence `high`. When none is found (a
  merged copy's evidence lives under its copy key) the signal cites the job's lifecycle history and
  is `medium`. Transitions without a source (decay) are not signals.
- Signals are append-only; a re-derivation that drops a transition leaves its signal (documented
  limitation; signals are events observed, not canonical truth).
- Not done: aggregate and canonical-change signals of vocabulary v1 (hiring acceleration, role
  family expansion, new location, remote policy, funding, sponsorship, team/leadership).

## OPS-5 job URL import (implemented 2026-10-30)

- `type=jobs` reuses the board import (`market.ats_boards.import`, new input `refreshBoards`) and
  adds a `refresh` node (`market.refresh_imported_boards`, parallel to `finalize`; `outputNode`
  stays `finalize`) that starts one refresh per board resolved to a company. Contract:
  `contracts/market-imports.md`.
- Found while testing: the board-file contact guard refused real Greenhouse job links (a 10-digit
  posting id reads as a phone number) and Lever/Ashby UUID links with long digit runs. In board and
  job URL files only, the posting id is set aside on the same hosts `boardRefFromUrl` accepts
  (including `boards.eu.greenhouse.io`): Greenhouse only `/<board>/jobs/<id>`, Ashby and Lever
  job pages only `/<board>/<uuid>`. A phone-length run (10–16 digits starting 0 or 44) and an id
  starting with 7 are still refused. `market.refresh_imported_boards` swallows only `invalid_state`
  (a disabled source). Any other `runNow` error fails the node so the retry uses
  `job_urls:<runId>:<sourceId>`.
- Admin ask: `/imports/new/jobs` (URL column mapping; same flow as `ats_boards`).
- Not yet verified on the owner's real job link file (Source DoD 1/7).

## Real-file gates (2026-10-30)

- NL IND passed after a fix; USCIS H-1B passed for the legacy archive export only. Details,
  numbers and fixtures: DECISION_LOG 2026-10-30. Tests:
  `sources/providers/registers/real-file-gate.test.ts` and the scratch-database import in
  `nl-register.int.test.ts`. Enabling either source on the MVP database is a separate step.

## M8.4b UK route taxonomy (implemented 2026-10-30)

- `UK_ROUTES` (`registers/uk.ts`, `uk-routes/1`): Government Authorised Exchange, Seasonal Worker,
  International Agreement are ignored by `market.uk_sponsor_register.import`
  (`process_sponsor_row` → `skipped_ignored_route`) and the generic register import.
- Never-delist (`company-policy/3`): see DECISION_LOG 2026-10-30. Test:
  `uk-route-taxonomy.int.test.ts` (fails when the reconciler skip is removed).

## OPS-4 signals — canonical-change part (implemented 2026-10-30)

- `CompanyChangeSignalWriter` (`signals/company-change-signals.ts`), daily
  `market.signals.company_changes`. Rules in DECISION_LOG 2026-10-30. A field whose signal was not
  written for lack of evidence stays at the previous value and is retried. Hiring acceleration is
  not emitted on the first comparison after baseline, nor when the prior 28-day window is empty.
  The pass resumes from the last company id in `market_signal_writer_cursors` and wraps to the
  start when the id space is exhausted. Test: `company-change-signals.int.test.ts`. Not done:
  `funding_event`, team/leadership (no source yet).

## FE-4 artifact delete (implemented 2026-10-30)

- Implemented on `foundation/fe-4-artifact-delete` (owner approved 2026-10-30). Record:
  `foundation-exceptions/FE-4-artifact-delete.md`.
- `purgeReleased` deletes raw bytes only when every market snapshot of that artifact is released
  and unpinned, none of those snapshots is currently held for any hold reason, and no open review
  or other market record cites the artifact id. The hold is read again immediately before the
  object delete, so a release the sweep reverted blocks deletion. Dry-run counts only. The daily
  `market.retention.sweep` workflow runs it after the sweep, at most 500 artifacts. Snapshot
  records stay; a later fetch of the same bytes stores them again.
