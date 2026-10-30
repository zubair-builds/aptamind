# Runbook: source failure

## Symptoms

- Dashboard "Sources" shows `degraded` (1–2 consecutive failures) or `failing` (≥ 3).
- Source detail shows `health.lastError`, failed runs, possibly a `parser_failure` or
  `source_anomaly` review item.

## What the system already guarantees

- A failed fetch **never** changes job lifecycle state and never closes jobs.
- A listing that cannot be parsed is recorded as a failure (never as "zero jobs") and raises a
  `parser_failure` review.
- Individual entries that cannot be mapped (malformed) or that the provider hides (Ashby
  unlisted) are **never treated as absent**: each listing moves their last sighting forward,
  but that is not a verification. A job whose entry stays skipped goes `POSSIBLY_STALE` through
  the freshness sweep and stays there (its Ashby check is inconclusive). A job whose Ashby entry
  is unlisted is marked `providerState: unlisted` ("hidden by provider") on its source copy
  until it is listed again or leaves the board. Malformed entries raise one low-severity `parser_failure`
  review ("N listing entries could not be mapped") per source, adapter version and set of
  malformed entries. Its context carries the counts and a sample of warnings. Dismissing it
  silences that exact set; a different set or a new adapter version raises a new item, which
  supersedes the older open one. If more than 10 % of a listing's listed + malformed entries are
  malformed, or one has no id, the listing is treated as incomplete and closes nothing until the
  adapter reads the board again.
- A dataset that shrinks by more than half, or with too many row failures, does not advance the
  "last complete import" marker — no companies are delisted — and raises a `source_anomaly`
  review.
- A job board listing below half its baseline with at least 10 fewer jobs (including an empty
  listing after a board of ≥ 10) closes nothing. It raises a `source_anomaly` review ("listing
  shrank from B to N jobs") and sets `health.listingHeld` (reason `shrink`) on the source. The
  fetch itself counts as successful. It stays held while the board stays that small.
- A board smaller than 10 that empties is held for one run without a review
  (`health.listingHeld`, reason `small_board_empty`). If the next listing is empty too, it is
  applied: its jobs become `POSSIBLY_STALE` and verification is scheduled.
- **Absence alone never closes a job.** Closing after missing listings needs two consecutive
  absences and a `not_found` verification since the first of them; a `live` verification ends
  the run. An Ashby check reads the whole board, so it is the same evidence as a listing, not
  an independent verification (DECISION_LOG b7f1a76). It counts as `not_found` only for a job
  absent from **two** applied listings at the job level (no other authoritative copy present),
  with no sighting or live verification since, and no hold on the source. For an empty board,
  no job on the source may have been seen since either. A dead small Ashby board closes its jobs
  after hold → apply → apply → read. A sighting or a live verification on that source after a
  small-board hold re-arms it. A one-off empty read never closes a live job.
- **Run evidence is authoritative only (DECISION_LOG a9af734).** Only official-ATS / official-site
  sightings (skipped entries included) and live verifications count as positive evidence for an
  absence run. Third-party sightings neither reset a run nor stop a closure. An absence after
  such evidence starts a new run (count 1). A hold is re-armed only by the held source's own
  copies and verifications against it: a job live elsewhere does not keep it held.
- **A verification result is re-checked when it is applied** (a9af734, 0bcc357). If the job was
  seen on an authoritative source or verified at or after the check, or (for an Ashby read) its
  absence run changed since, the `not_found` is applied as `inconclusive`; a `live` checked
  before the job was closed or recorded a `not_found` is applied as `inconclusive` too. The
  operation records `appliedOutcome` and `appliedNote`. Jobs on a **disabled** source are not
  verified through it (another authoritative copy is used). A job whose only authoritative
  copies are on disabled sources cannot close: it decays to `POSSIBLY_STALE` until you re-enable a
  source. Third-party copies are never verified. Verification reads a present authoritative copy first, and "absent from
  listings" means no authoritative copy of the job is present **on an enabled source** (a copy
  frozen as present on a disabled source does not keep a job listed).
- **A failed or misconfigured fetch never changes job state (PR #11 re-verify #7).** A copy is
  verified only on the board it was seen on (`sourceRefs[].board`). While a source's latest
  listing fetch has failed, or after its endpoint was changed (`endpointChangedAt`), its jobs'
  verifications are `inconclusive` (see their `detail`) until a listing on the current endpoint
  succeeds and shows them. A mistyped board token or URL therefore closes nothing: `PATCH` the
  endpoint back; copies whose board matches the endpoint again verify as before. Copies seen
  before boards were recorded are verified only if the endpoint did not change after they were
  last seen (the source's `endpointChangedAt`, else its `source.updated` audit events).
- **The lifecycle is derived from evidence (PR #11 re-verify #8, DECISION_LOG 6a01b36).** Every
  listing presence/absence and verification result is recorded once in `market_job_evidence`
  and each job's lifecycle is recomputed from it, ordered by time. Consequences for operators:
  a listing read from a wrong board is no evidence
  about the source's existing jobs (they stay as they were and decay through the stale sweep) —
  fix the endpoint and the next listing on the right board counts again; a `PATCH` while a
  listing is in flight cannot relabel it; reprocessing a snapshot never changes source health.
  **As of re-verify #9 (DECISION_LOG 15c965b)** a source's standing and a copy's board are
  evaluated as of each piece of evidence's time: disabling a source (or fixing an endpoint) never
  re-opens, closes or rewrites the history of a job — it affects only what comes after, and the
  source's jobs are re-derived right away (`market.source.recompute_jobs`, visible in the runs
  list, labelled `standingOfSource`). A disable ends any 404 streak or absence run; after a
  re-enable the job starts counting again from zero.
  **As of re-verify #10 (DECISION_LOG 9b0cb03)** that recompute is durable: until it finishes the
  source shows `standingRecompute { pendingAt, cursor }`. A marker older than 15 minutes (a crash,
  a failed or cancelled run) is resumed by the next freshness sweep from its cursor; toggling the
  same value again also re-enqueues it. If a job looks out of date after a worker crash or a
  "lifecycle recompute did not converge" error, any recompute of it (the next listing,
  verification, sweep, or `market.source.recompute_jobs`) folds every recorded piece of evidence —
  nothing is lost, and the failing step is retried by its node.
  **As of re-verify #11/#12** the freshness workflow's `evidence` node
  (`market.sweep_recorded_evidence`) re-derives every job named by evidence recorded since its
  last pass (`market_job_evidence_sweeps` holds its watermark; `createdAt` is the database's time,
  and evidence younger than 5 minutes by the database clock waits for the next pass), CLOSED jobs
  included. It keeps paging while behind, within its 8-minute budget (10-minute node timeout), at
  roughly 170 evidence documents per second (measured in review). **Provided it keeps up** — its
  output shows `complete: true` and `lagMs: 0` — every job matches its evidence within one sweep
  interval plus 5 minutes, whatever happened to the step that recorded it. If `complete` stays
  false, `lagMs` says how far behind it is: one pass handles roughly 80k documents (8 minutes at
  ~170/s), so more new evidence than that per hour will not keep up (run the workflow more often). A job whose re-derivation fails is logged and recorded
  at once in `market_job_lifecycle_failures` (one document per job: `failures`, `code`, `since`,
  `lastAt`; `failing` in the output counts them) and retried first by later sweeps, least recently
  tried first; after 3 consecutive failures a `lifecycle_failure` review item names the job and the
  error code. It is dismissed automatically when the job recovers; after you dismiss it, it is
  raised again only if the error code changes.
  Health changes only for a run whose fetch is still the source's latest (`health.latestFetch`):
  after a failed fetch, an older run finishing late does not turn the source healthy again, and
  the failure streak (`consecutiveFailures`) is kept by the fetches themselves (a newer success
  resets it, a newer failure adds one; retries within a run count once).
  To see why a job is in its state, read its evidence:
  `db.market_job_evidence.find({ copyKey: { $in: <job.sourceKeys> } }).sort({ at: 1 })`.
- **Late results never rewind a job.** An older verification applied late is evidence at its
  own (earlier) time: it can never reopen a job closed after it, nor extend a not_found streak
  across a later live read. A verification whose source is disabled (or deleted) does not count
  while it is; one recorded under an older verification logic version is recorded as
  `inconclusive` (`appliedNote` says why).
- **Unsupported providers.** The start-up log lists job sources whose stored provider is not a
  supported one ("job sources with a provider outside the supported set"). Their copies are
  never authoritative (they neither keep jobs live nor close them). Re-register such a source
  under a supported provider (`greenhouse`, `ashby`, `lever`, `careers_page`, `aggregator`,
  `manual`) and disable the old one.
- Transient errors (timeouts, 408/429/5xx) are retried with backoff; each attempt is visible in
  the run's node attempts.

## Diagnose

1. Open the failed run (Source → recent runs → run). Check the failing node's attempts and error:
   - `HTTP 403/404` → endpoint moved / board token changed / access policy changed (terminal).
   - `HTTP 429/5xx`, timeout → provider trouble (retried).
   - `Unexpected <provider> response shape` → provider API changed → adapter update needed.
   - `unsafe_url` → the endpoint resolves to a blocked address; fix the source URL.
2. Inspect the stored snapshot (Source → snapshots → artifact) to see exactly what was returned.
3. Check `/metrics` for `queue_job_failures_total` and the worker logs filtered by `sourceId`.

## Remediate

| Cause                       | Action                                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Temporary outage            | Nothing, or **Run now** once the provider recovers. Jobs are verified on schedule.                                                                                                                                                                 |
| Board moved / token changed | `PATCH /api/sources/:id` (endpoint) or register the new board; disable the old source.                                                                                                                                                             |
| Entries could not be mapped | Open the `parser_failure` review's sample and the snapshot (`context.snapshotId`). A provider field change → adapter update as below; a genuinely broken posting upstream → `dismiss`. Jobs are not closed meanwhile.                              |
| Provider format changed     | Update the adapter in `packages/market/src/connectors/` (add a fixture reproducing the new shape, bump `adapterVersion`), deploy, then **reprocess** the failing snapshot (see reprocessing runbook).                                              |
| Anomalous dataset           | Inspect the snapshot. If genuine, resolve the `source_anomaly` review with `confirm` and re-run; if not, `retry` later.                                                                                                                            |
| Job listing shrank          | Compare the snapshot with the provider's public board. If genuine (hiring freeze, board cleanup), resolve the review with `confirm`: the next refresh applies the absences. If it is a provider glitch, `retry` or wait; nothing closes meanwhile. |
| Persistent failure          | Disable the source (`POST /api/sources/:id/disable`) to stop scheduled attempts; the schedule is disabled with it.                                                                                                                                 |

Jobs from a failing source become `POSSIBLY_STALE` only via the freshness sweep (no confirmation
within 72 h), and are verified individually — never closed wholesale.
