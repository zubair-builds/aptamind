# Runbook: reprocessing

Every acquisition stores an immutable, content-addressed snapshot. Reprocessing re-runs the
source workflow from that snapshot **without refetching** — used after parser/adapter fixes,
logic/policy version bumps, or to replay history.

## Reprocess a source snapshot

- Admin: Source → snapshots → **Reprocess**, or
- API: `POST /api/snapshots/:snapshotId/reprocess` (starts the source workflow with `snapshotId`), or
- `POST /api/sources/:id/run` with body `{ "snapshotId": "snap_…" }`.

Guarantees:

- Observations are deterministic (source + record + payload hash): unchanged records are
  touched, not duplicated; changed parsing yields new observations while history is kept.
- Companies/jobs resolve to the same canonical entities (idempotent resolution).
- Reprocessing a job listing does **not** count as a new observation of absence (a listing is
  applied at most once, keyed by the snapshot's fetch time), so it cannot close jobs.
- A sponsor-register reprocess re-evaluates licences against the source's latest complete import.

## Upload an externally obtained file

`POST /api/sources/:id/snapshots?process=true` with the raw file body and its content type
(e.g. `text/csv`). The file becomes a snapshot and is processed like a fetched one.

## Sponsor register first import (real-file gate, DECISION_LOG "Sponsor register adapters" (9))

A new register adapter's committed fixtures are synthetic (the build environment cannot reach the
publishers). A register source (`nl_ind_recognised_sponsors`, and any later adapter) is **not
enabled in production** until a real file has been checked:

1. On a **non-production** database, register the source **without a schedule** and upload the
   real downloaded file as an operator snapshot: `POST /api/sources/:id/snapshots?process=true`
   (`text/plain` for a saved HTML page, `text/csv`, `text/tab-separated-values` or
   `application/octet-stream` otherwise).
2. Read the run's `parse` node output and compare with the published page: `format`, `routes[]`
   (every published register or category classified as intended; nothing labour that is not),
   `unlistedRoutes` (should be empty — otherwise extend the taxonomy by exact alias), `skippedRows`
   and the totals (`count`, `totalRows`) against the row count the publisher shows. Spot-check a
   few companies' licences and identity (KvK).
3. Confirm the category/route mapping against the publisher's documentation. H-1B: confirm the
   file's encoding and delimiter, that the header matches the legacy or current export, and the
   category mapping (initial = New Employment; continuing = Continuation, Change with Same
   Employer, New Concurrent, Change of Employer, Amended) against the USCIS Data Hub
   documentation; check `periods[]` and that `skippedRows` (`column_count_mismatch`,
   `invalid_count`) is near zero.
4. Commit a trimmed recorded fixture of the real file (a few rows per route, personal names
   removed) and switch the adapter's tests to it.
5. Log the check (file date, counts, findings) in `docs/programme/DECISION_LOG.md`.
6. Only then enable the source in production (and add its schedule).

## Market deploy (DECISION_LOG 3dfe3c5 (4))

**M11.5 release (US H-1B history, `employment-policy/2026-09-30.8`):** the validators only widen
(new optional company fields `employment.sponsorship.history` / `historyCountries`, observation
field `payload.sponsorshipHistory`), so no drain is needed. After the deploy, run the outdated
re-interpretation (below) so jobs pick up the per-country company axis. It changes jobs of
companies with H-1B history and jobs of companies licensed elsewhere with a lapsed licence in the
job's country (the PR #21 L6 fix). The steps below describe the `.7` release.

**After each first H-1B import of a fiscal year:** jobs of companies that gained US history pick
it up on their next sighting (next listing refresh); to apply it now, re-interpret those
companies' jobs (`POST /api/jobs/:id/reinterpret`, or the outdated backfill after a version
bump). **Unmatched H-1B rows** leave no observation: after the company base grows (a directory
import adding US locations), reprocess the stored fiscal-year snapshots
(`POST /api/snapshots/:id/reprocess`) to re-evaluate them. A held-back fiscal year
(`source_anomaly`, "FY… held back (shrank …)") keeps its previous rows: check the file; if it is
right (e.g. USCIS corrected the year), **confirm** that review, then re-run the snapshot
(`POST /api/snapshots/:id/reprocess`) — the confirmation applies to exactly that year, snapshot
and row count; a retry without a confirmation keeps the year held. A history import whose rows
failed above the failure ratio (5 % at finalisation; the row fan-out fails above 20 %), or whose
year marker moved during the import ("marker moved"), applies nothing for the year; rows it did
process count beside the year's previous rows until the next complete import of that year, so
**re-run a failed or held import** once the cause is fixed.

A Market release that bumps the interpretation versions (this one: `employment-policy/2026-09-30.7`)
is deployed in three named steps. **This release is a drain-first deploy:** it narrows a
`$jsonSchema` validator (interpretation flag `value` is now `yes | no`), so an old process must
not write while the new validators are in place.

1. **Drain (the processes, not the runs).** Send `SIGTERM` to every old worker and **wait for
   each process to exit**: a worker stops taking work and lets its in-flight nodes finish before
   it exits (`apps/worker/src/main.ts`, shutdown; a node that cannot finish keeps its lease until
   it expires and is recovered). Then stop the old API. Do **not** use run state as the drain
   signal: a run with queued nodes stays `RUNNING` until a worker picks them up, so it would never
   leave that state while no worker runs.
2. **Start new.** Start the new API and workers. Boot applies the migrations and the Market
   collections (validators and indexes, including `by_policy_version`). Runs that were still
   queued or running resume on the new workers; every node is idempotent or fenced, so the
   resumed work is safe. While outdated jobs remain, every Market boot logs the warning
   _"Market: jobs interpreted under an older employment policy remain; run
   market.jobs.reinterpret_outdated until done"_ with `outdatedJobs` (an index-only count).
3. **Run the backfill until done** — `market.jobs.reinterpret_outdated` (below). The deploy is
   finished when the report says `done: true` and the boot warning is gone.

Until step 3 finishes, jobs show their stored (older) interpretation — nothing is downgraded at
read time — so step 3 is not optional.

## Re-interpret jobs after a logic change

Every job records the versions it was interpreted with (`interpretation.logicVersion`,
`policyVersion`, `taxonomyVersion`; also on each `view=summary` row), so old and new outputs are
distinguishable. **The rule: every job whose `interpretation.policyVersion` is older than the
current one (since DECISION_LOG 8d96663 / 3dfe3c5, `employment-policy/2026-09-30.7`) needs
re-interpretation.** Nothing is downgraded at read time: a job shows its stored interpretation
until it is re-interpreted, so the backfill below is step 3 of every Market deploy that bumps the
version.

### Deploy step: the re-interpretation backfill (DECISION_LOG 8d96663 (3), 3dfe3c5 (4))

Right after the new version is running, run the Market backfill workflow
`market.jobs.reinterpret_outdated` until it reports `done`:

```bash
# one page (default 1000 jobs); the run's output is the report
curl -s -X POST "$API/api/workflows/market.jobs.reinterpret_outdated/runs" \
  -H 'content-type: application/json' -d '{"input": {"limit": 1000}}'
# → { runId }; then GET /api/runs/<runId> until COMPLETED and read its output:
# { policyVersion, selected, succeeded, failed, remaining, nextAfter, done }
```

- It selects, in `_id` order, every **active** job whose `interpretation.policyVersion` is
  **older** than the current one — **whatever its lifecycle state** (`CLOSED` and
  `POSSIBLY_STALE` included) and whether or not its sources are enabled — and re-reconciles each
  with `market.reconcile_job`, the code `market.job.reinterpret` runs (4 chunks of 20 in
  parallel). Merged jobs are skipped (their survivor is the canonical job), and so are jobs with
  a **newer** version (after a rollback it never re-interprets newer output with older code).
  Selection and counts use the `by_policy_version` index; no page scans the collection.
- **Replay-safe and resumable:** a re-interpreted job carries the current version and drops out
  of the selection, so re-running the workflow does only what is left; a retried chunk resumes
  (`core.for_each` keeps completed chunks). Re-run until the report says `done: true`
  (`remaining: 0`). If `failed > 0`, the failed jobs stay outdated: look at the run's
  `sampleFailures`, fix the cause, and re-run; to page past jobs that keep failing, pass the
  report's `nextAfter` as `input.after`.
- **Decided questions stay decided** (3dfe3c5 (3), a720377 (2)): reconciliation does not re-raise
  a review whose last item for the same key was resolved or dismissed by an operator with the
  same evidence (`context.evidenceHash` under the current `context.evidenceVersion`; ANY earlier
  such decision counts), and it raises no new review for a `CLOSED` job. An item closed
  **before** evidence hashes existed, or under an older digest version, does not suppress: where its condition still holds,
  the question is asked **once more** (the new decision records its hash). Upper bound of those
  re-asks before you run the backfill (open jobs only; the job must still show the condition):

  ```js
  // mongosh: keys with operator-closed reconciler items but none under the current digest
  // version (2), on jobs that are not CLOSED and have no open item for the key — an upper
  // bound of re-asks (5a13fed L-d, 7f01fe5 L5)
  db.market_review_items.aggregate([
    {
      $match: {
        'entity.kind': 'job',
        status: { $in: ['resolved', 'dismissed'] },
        type: { $in: ['employment_conflict', 'field_conflict', 'salary_suspicious'] },
        'resolution.actor.kind': { $ne: 'system' },
        'resolution.action': { $ne: 'retry' },
      },
    },
    {
      $group: {
        _id: '$dedupeKey',
        type: { $first: '$type' },
        jobId: { $first: '$entity.id' },
        current: { $max: { $cond: [{ $eq: ['$context.evidenceVersion', 2] }, 1, 0] } },
      },
    },
    { $match: { current: 0 } },
    {
      $lookup: {
        from: 'market_review_items',
        let: { key: '$_id' },
        as: 'open',
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$dedupeKey', '$$key'] }, { $eq: ['$status', 'open'] }] } } },
          { $limit: 1 },
        ],
      },
    },
    { $match: { open: { $size: 0 } } },
    {
      $lookup: {
        from: 'market_jobs',
        localField: 'jobId',
        foreignField: '_id',
        as: 'job',
        pipeline: [{ $project: { 'lifecycle.state': 1, status: 1 } }],
      },
    },
    { $match: { 'job.lifecycle.state': { $ne: 'CLOSED' }, 'job.status': 'active' } },
    { $group: { _id: '$type', keys: { $sum: 1 } } },
  ]);
  ```

  A re-asked item's reason ends "(asked again: the earlier decision predates evidence
  tracking)".

- Counts are logged by the `select` node (`selected`, `skippedMerged`, `skippedNewer`,
  `outdatedTotal`) and the `report` node (`selected`, `succeeded`, `failed`, `remaining`).
- **Operator overrides survive:** reconciliation applies stored overrides as always. A
  sponsorship override keeps its `status` and `roleStatement`; the company capability is
  recomputed (B-L2).
- It is a workflow, not a boot migration, because it needs the whole Market domain (company
  resolution, review raising and closing) and can run for minutes on a large store; migrations
  stay short and schema-only.

### Other re-interpretation paths

- **Jobs on refreshed sources update by themselves.** Each scheduled or manual refresh
  (`POST /api/sources/:id/run`) is a newer sighting of every job still on the board, and a newer
  sighting re-reconciles the job with the current logic.
- **Reprocessing a snapshot does not re-interpret.** A sighting that is not newer than the copy's
  last one is a replay (it changes nothing, by design), so re-running an old snapshot is not a
  re-interpretation path.
- **One job at a time:** Admin job page → **Re-interpret**, or `POST /api/jobs/:id/reinterpret`
  (`market.job.reinterpret` → `market.reconcile_job`, idempotent). Use it for a job whose
  company evidence changed (a licence granted or lapsed) since its last sighting: a change to a
  company's licences does **not** cascade to its jobs, which pick it up on their next
  reconciliation. (Status filters such as `GET /api/jobs?sponsorship=company_capable` are **not**
  a way to find outdated jobs: they miss every job whose stored status the new policy no longer
  produces, e.g. a posting-text `explicit_yes` stored under `employment-policy/2026-09-27.1`.)

## Re-reconcile a company

Admin company page → **Reconcile**, or `POST /api/companies/:id/reconcile`. Recomputes all facts
from its observations; changes update `freshness.lastChangedAt`.

## Retry a failed workflow step

Run detail → failed node → **Retry** (`POST /api/node-runs/:id/retry`). Attempt history is
preserved; only safe (idempotent) capabilities can be retried; for `core.for_each`, completed
chunks keep their results and only the rest are re-run.
