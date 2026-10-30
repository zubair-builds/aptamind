# Contract: Market runs (workflow runs as they relate to sources, companies and jobs)

Owner: Market for the Market meaning of runs (labels, workflow keys, node outputs). The
run/node-run endpoints themselves belong to the **runtime** (frozen `packages/workflows`;
routes in `apps/admin/lib/api-server/routes/workflows.ts`). Consumer: Admin UX (run views; activity tabs on
Market records). Status: **v1.2 (M6.2)** = v1 (`d9799b6`) + company and job run history (M7.6, v1.1) + batch runs linked to the jobs they change and merged records at any depth (M6.2). Conventions: [market-provenance](market-provenance.md).

## Runtime endpoints used (not Market-owned; shapes by path)

| Endpoint                                                                | Response                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/runs?workflowKey&state&sourceId&parentRunId&all&limit&offset` | `Page<WorkflowRunDoc>` without `input`/`output` (`packages/workflows/src/schemas.ts`). Top-level only unless `all=true`. `sourceId` filters on the run **label** `sourceId`. Sort: `createdAt` descending. |
| `GET /api/runs/:id`                                                     | `WorkflowQueries.getRunDetail` (`packages/workflows/src/queries.ts`): `{ run, version{id,version,title,edges}, nodes[{nodeId,title,capability,…,nodeRun,chunkStates}], children{state:count}, artifacts }` |
| `GET /api/node-runs/:id`, `/chunks`                                     | node run with attempts, input, output and error; fan-out chunks                                                                                                                                            |
| `POST /api/runs/:id/cancel`, `POST /api/node-runs/:id/retry` / `resume` | operator controls (runtime semantics)                                                                                                                                                                      |
| `GET /api/workflows`, `/api/workflows/:key`, `/api/schedules`           | definitions, versions, recent runs, schedules                                                                                                                                                              |

Run states: `PENDING | RUNNING | WAITING | CANCELLING | COMPLETED | FAILED | CANCELLED`. Node
states: `QUEUED | RUNNING | FANNING_OUT | RETRY_SCHEDULED | WAITING | COMPLETED | FAILED | SKIPPED
| CANCELLED` (`packages/workflows/src/state-machine.ts`).

## Market workflows and how they link to records

Templates: `packages/market/src/workflows/index.ts`.

| Workflow key                        | Started by                                                                   | Labels                                                                                      | Record link                                                                          | Useful node output (in `nodes[].nodeRun`)                                                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `market.uk_sponsor_register.import` | source schedule or run; review `retry`                                       | `sourceId`                                                                                  | source                                                                               | `finalize`: import completeness, anomaly held or applied, delisted count                                                                                                       |
| `market.company_directory.import`   | upload with `process=true`; source run with `snapshotId`; snapshot reprocess | `sourceId`                                                                                  | source → companies                                                                   | `map`: `{rowCount, importable, errorCount, errors[], report, warnings[]}`; `finalize`: `{imported, rowErrors, processingFailures, outcomes, reviewItemId, report, warnings[]}` |
| `market.ats.refresh`                | source schedule or run; review `retry`; snapshot reprocess                   | `sourceId`                                                                                  | source → jobs                                                                        | `fetch`: `{snapshotId, count, complete, warnings[]}`; `finalize`: `{absenceApplied, reason, absent, closed, possiblyStale, alreadyApplied, seen}`                              |
| `market.careers_page.crawl`         | source schedule or run                                                       | `sourceId`                                                                                  | source → jobs                                                                        | `extract`: records; never closes jobs by absence                                                                                                                               |
| `market.company.discover_careers`   | `POST /api/companies/:id/discover-careers`; batch child                      | `companyId` (manual only)                                                                   | company                                                                              | `discover`: `{companyId, status, careersUrl, ats[], pagesFetched}`; `register`: registered sources                                                                             |
| `market.careers_discovery.batch`    | `system:careers-discovery` source schedule or run                            | `sourceId`                                                                                  | discovery source → child runs                                                        | `select`: `{companyIds}`                                                                                                                                                       |
| `market.jobs.verify_due`            | hourly schedule; `POST /api/jobs/:id/verify`                                 | `jobId` (manual only)                                                                       | job                                                                                  | per-item verification outcomes                                                                                                                                                 |
| `market.job.reinterpret`            | `POST /api/jobs/:id/reinterpret`                                             | `jobId`                                                                                     | job                                                                                  | `{jobId, changed, conflictFields, workModel, sponsorship}`                                                                                                                     |
| `market.freshness.sweep`            | hourly schedule                                                              | —                                                                                           | dashboard; jobs it changes (audit `job.lifecycle_rederived`, M6.2)                   | stale marks, overdue sources, review recovery counts                                                                                                                           |
| `market.company.process_candidate`  | subworkflow of imports                                                       | inherited                                                                                   | company                                                                              | `resolve`: `{companyId?, outcome}`                                                                                                                                             |
| `market.source.recompute_jobs`      | a source's standing change (enable or disable)                               | `standingOfSource` (not `sourceId`: no acquisition run; not indexed, not in activity views) | source → jobs; each job it changes (audit `job.lifecycle_rederived`, M6.2)           | `recompute`: `{jobs, written, pages}`                                                                                                                                          |
| `market.jobs.reinterpret_outdated`  | manual run: Market deploy step (reprocessing runbook)                        | —                                                                                           | jobs (one page per run); each job it re-interprets (audit `job.reinterpreted`, M6.2) | `report`: `{policyVersion, selected, succeeded, failed, remaining, nextAfter, done}`                                                                                           |

Rules for the UI:

- **Source activity** = `GET /api/runs?sourceId=<id>` (paginated). The source detail already
  embeds the latest 20.
- **Company or job activity** (M7.6) = `GET /api/companies/:id/runs` and `GET /api/jobs/:id/runs`
  (Market routes, no runtime change; contracts [market-companies](market-companies.md) and
  [market-jobs](market-jobs.md)). The `companyId`/`jobId` labels exist only on manually started
  runs, so these endpoints add the runs that wrote the record's observations, verifications and
  audit events; each row says why (`linkedBy`). Paged newest first; indexes `by_label_company` and
  `by_label_job` on `workflow_runs` (partial on the label) serve the label part.
  - **Index names:** these docs name the index **spec** (`MARKET_RUN_LABEL_INDEXES` in
    `packages/platform`). The live index can carry a derived name: when a legacy definition held
    the spec's name (the sparse `by_label_source` of migration 2026-09-27-003), the replacement is
    built first under `<name>__<hash8>` (e.g. `by_label_source__4743dab7`) and the old one dropped.
    Match indexes by key, never by name.
  - **Scope:** runs labelled with the record or with a record merged into it at any depth
    (`mergedInto` followed breadth first through `by_merged_into`, at most `MERGE_CHAIN_MAX`
    levels and 200 records — beyond that the page says `truncated: true`; M6.2 — was one hop), plus the runs linked through what the record owns
    now and, for a job, the verifications of the jobs merged into it (a merge moves observations
    and copies, never verifications: M6.2).
  - **Batch runs that change a job** (M6.2): `market.source.recompute_jobs`, the freshness sweep
    (its stale sweep, its resumed standing recomputes and its recorded-evidence sweep) and
    `market.jobs.reinterpret_outdated` carry no `jobId` label. Each job such a run actually
    changes gets one audit event linked to the run (`runId`): `job.lifecycle_rederived`
    (`details.cause` = `source_standing` | `stale_sweep` | `recorded_evidence`, with `from`/`to`
    lifecycle states) or `job.reinterpreted`. So the run appears in the job's history with
    `linkedBy: ['audit']`. A job the run re-derives without a change is not linked. Best effort:
    at most one event per distinct change; a crash between the job write and the audit write can drop the link (a replay records nothing new). Actors `system:market-lifecycle` and
    `system:market-reinterpretation`.
  - **Bound:** at most `MAX_LINKED_RUNS` (2 000) observation-, verification- and audit-linked runs
    each, collected **newest first**; when older ones were left out the page says
    `truncated: true` (label-linked runs are never bounded). Show "older activity not listed".
- A 202 `{ runId }` from any Market action should link to `/runs/:runId`, and the record should
  refresh when the run reaches a terminal state (poll `GET /api/runs/:id` → `run.state`).
- **Failure presentation.** Market capabilities classify errors: `TerminalError` (for example
  "Source … lacks a board token", "Unexpected greenhouse response shape") does not retry;
  `RetryableError` (HTTP 5xx/429) retries with backoff. An unparseable listing also raises a
  `parser_failure` review. Link the failed node to that review (`GET /api/review?entityId=<sourceId>`).
- A failed or partial refresh **never** changes job state. The UI must not describe a failed run
  as "jobs closed".
