# Market Foundation v0.1 — execution status

Audited branch `claude/market-context-prd-review-ouah2y` (`f9dd9f4`, unchanged); hardening
branch `claude/market-foundation-hardening` (from exactly `f9dd9f4`; re-audited at `1b721b7`, then the
final repair pass; audited at `b715f80`, then the final two-blocker repair). Authority: owner instructions →
[`market-context-and-requirements.md`](../architecture/market-context-and-requirements.md) →
[`market-prd.md`](../product/market-prd.md) → ADRs.

## Milestones

| Milestone                                             | Status                                  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F0** Repository & infrastructure                    | Done                                    | pnpm monorepo, strict TS, lint/format/test config, config validation, Mongo/Redis/S3 packages, `docker-compose.yml` (MongoDB 7 rs0, Redis 7, SeaweedFS S3 — also used by CI) + optional native fallback `scripts/local-infra.sh`, structured logging, `/health` `/ready` `/metrics` on API and worker, CI workflow, ADRs, dependency + architecture guards. API, worker and admin start and pass readiness. |
| **F1** Durable workflow runtime                       | Done — passed the F1 audit gate (below) | `packages/workflows` structured as an orchestrator over explicit components (ADR-0013); 13 runtime + 13 gate integration tests, 30 runtime unit tests; real headless-Chromium fetch.                                                                                                                                                                                                                        |
| **M1** Sources, snapshots, observations, Company core | Done                                    | Sources (config, schedule sync, authority, governance, health), content-addressed snapshots, append-only observations, canonical Company with fact-level provenance/confidence/conflicts, deterministic resolution, review items, audited merges.                                                                                                                                                           |
| **M2** UK sponsor register workflow                   | Done (fixture-verified)                 | `market.uk_sponsor_register.import`: locate CSV → download/snapshot → parse → map → filter → bounded fan-out → finalize. Idempotent re-runs, delisting on a later complete register, anomaly guard, reprocessing, review for ambiguity — all integration-tested against a local fixture server. Registry presence → company capability only.                                                                |
| **M3** Careers/ATS discovery + Job core               | Done (fixture-verified)                 | Careers discovery + ATS detection, job source registration, Greenhouse/Lever/Ashby/aggregator adapters, canonical jobs, job resolution (syndication, requisition siblings, reposts), lifecycle with safe absence handling.                                                                                                                                                                                  |
| **M4** Employment & job intelligence                  | Done                                    | Deterministic interpreter (work model, remote scope, office attendance, sponsorship vs company capability, authorization, relocation, salary normalization, requirements, responsibilities, title/seniority/family) with evidence spans; 28 golden job cases.                                                                                                                                               |
| **M5** Verification, freshness, hardening             | Done                                    | Freshness policies per data class, due queries, verification workflow, stale sweep, source health, review queue UX, provenance UX, run inspection, data-quality metrics, golden suite (`pnpm eval:golden`), runbooks.                                                                                                                                                                                       |

## Final two-blocker repair — independent audit of `b715f80`

The independent audit of `b715f80` returned **FAIL — do not freeze foundation** with exactly two
blockers. The limitations recorded below under _Remaining limitations (B-3)_ described both. This
pass closes only those two races, promotes the auditor's reproductions and probes to permanent
tests, and was mutation-checked. It does not declare the foundation frozen.

| Finding                                                                                    | Result | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Evidence (`review-resolution.int.test.ts`)                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B3-R1** obsolete review generation can launch a source retry after a newer decision wins | FIXED  | Durable, generation-bound **retry intent** (`market_review_retry_intents`, id per item + operation), inserted in the same fenced transaction that moves the operation to `applied`. No owner calls the launcher. The dispatcher (first outbox step, plus a stale-intent sweep in `recoverIncomplete`) checks that the intent is its item's decided retry (a monotonic predicate) and **cancels** it otherwise. It records the attempt and starts the run with the intent's idempotency key, then records `delivered` + run id | Codex scenario 2 (A gen 1 paused before its effect; B gen 2 released; C dismisses gen 3; A resumes): 0 runs, 0 intents, item dismissed by C, A gets 409 — also after every recovery/dispatcher sweep. A committed retry cannot be superseded (one run). Crash matrix below                                                                                                            |
| **B3-R2** stale company reconciliation can overwrite newer canonical state                 | FIXED  | `market_companies.rev`. The reconciler reads the company (revision R) before its evidence and writes **only the derived fields** `WHERE rev = R`, advancing it; a merge into the company advances it too. On mismatch the result is discarded and recomputed from a fresh read (bounded), never re-submitted. Identity keys and derived reviews come from the committed state only                                                                                                                                            | Codex probe (A computes `stale.example`, pauses before its write, loses its generation; R2 sets `newer.example`; A resumes): website stays `https://newer.example`, A recomputes and gets 409. Two reconcilers from one revision: the loser recomputes and keeps the new evidence. Review override during a source reconciliation is not reverted. Concurrent `distinctFrom` survives |

Retry intent crash matrix (all permanent):

| Crash point                                              | Outcome                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Before the intent is persisted (inside the fenced txn)   | Nothing committed, 0 runs; recovery commits one intent (generation 2) and one run                      |
| After the intent is persisted, before dispatch           | Item resolved, intent pending, 0 runs; the dispatcher sweep delivers one run; outbox records it        |
| During the dispatcher claim (attempt recorded)           | Intent `dispatching`, 0 runs; recovery launches once (attempts 2)                                      |
| Launch succeeded, crash before the `delivered` marker    | 1 run; recovery and the caller's retry reuse the **same** run (idempotency key), 1 run-requested audit |
| Repeated and concurrent dispatch (6 concurrent + sweeps) | All return the same run id; 1 run                                                                      |
| Intent whose operation is superseded / not yet committed | `cancelled`, never launches, not picked up again by the sweep                                          |

Also promoted to permanent tests: retry source missing or disabled is rejected before the claim
(no operation, item open, the corrected decision succeeds). The audit event and the workflow
resume each succeed and then crash **before** their delivered marker; after recovery there is
exactly one audit event and one resume.

Mutation checks (each applied alone, the named regression run, then restored):

| Mutation                                                             | Failing regression and how it fails                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Generation/state fence removed from the intent transaction           | Codex scenario 2: an obsolete intent is committed (the dispatcher still cancels it)         |
| Dispatcher authority (supersession) check removed                    | superseded-intent test: the stray intent is **delivered** (source run launched)             |
| Both of the above                                                    | Codex scenario 2: **the obsolete retry launches a source run**                              |
| Old design restored (lease check, then `runNow`, then fenced commit) | Codex scenario 2: **the obsolete retry launches a source run**                              |
| Deterministic run/intent idempotency key removed                     | crash-after-launch test: a **second (duplicate) run** is started on recovery                |
| Company revision predicate removed                                   | Codex reconciliation probe: website regresses to `https://stale.example`                    |
| Reconciler retries the old computed payload instead of recomputing   | two-reconcilers test: the new evidence is reverted; override test: `https://source.example` |

**Audited without change.** `JobReconciler` already writes only derived fields under a job-revision
compare-and-set and re-reads and re-derives on mismatch. Every review effect on a job (override,
merge) advances the job revision, so a stale review-triggered job reconciliation cannot land.
The post-review reconciliation calls (`ReviewService.recompute`: company resolution/duplicate →
`CompanyReconciler`; job duplicate and job corrections → `JobReconciler`; company corrections →
`CompanyReconciler`) are therefore all revision-fenced.

### Validation (this pass)

Local stack: MongoDB 7.0 (rs0), Redis 7 and SeaweedFS S3 via `scripts/local-infra.sh`, with
Chromium 1194 sandboxed through `scripts/chromium-unprivileged.sh`. Docker was not available in
this environment; CI uses Docker Compose.

| Check                                                                     | Result                                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `format:check`, `lint`, `typecheck`, `check:deps`, `check:arch`, `build`  | pass                                                                                      |
| `pnpm test` (unit)                                                        | 616 passed, 47 files                                                                      |
| `pnpm eval:golden`                                                        | 78/78                                                                                     |
| B-3 suite (`review-resolution.int.test.ts`, 37 tests, was 22)             | **10 consecutive green runs**                                                             |
| Full non-browser integration (runtime 32 + Market/API 83 = 115, 10 files) | **5 consecutive green runs** (the runtime suite is part of each)                          |
| Browser security suite                                                    | 21 passed, 0 skipped — **2 consecutive green runs**                                       |
| Unhandled rejections, Mongo transaction errors, open handles, leaks       | none (the only `ECONNREFUSED` is the runtime gate's simulated Redis outage, once per run) |
| Mutation checks (table above)                                             | every mutation fails its named regression; all restored                                   |

GitHub CI on `450c744` (code, tests and docs of this pass): [run 36550241234](https://github.com/mateeqazam/aptamind/actions/runs/36550241234),
job `checks` green on all 16 steps — unit 616, runtime 32, browser 21, Market/API 83 (7 files),
golden 78/78, build.

### Remaining limitations (this pass)

- If a dispatcher crashes after starting the run and before recording `delivered`, **and** the
  source is disabled or deleted before the next dispatch, that dispatch settles the intent as
  `failed` (no launch), even though the run from the crashed attempt exists. No second run is
  started. Only the bookkeeping (`runId` on the intent and resolution) is missing.
- A job reconciliation's own write does not advance the job revision (unchanged, accepted
  earlier). Two job reconciliations at the same revision with different company snapshots
  therefore end last-writer-wins on company-derived job fields. Review-triggered job changes
  always advance the revision; this is not the review-generation race class.
- Company reconciliation gives up after 10 consecutive revision conflicts (`ConflictError`,
  metric `company_reconcile_revision_conflicts_total`). It never writes a stale result.

## B-3 final repair — independent audit of `95b15b4`

The independent audit of `95b15b4` returned **FAIL — do not freeze foundation**, with everything
except B-3 review-resolution durability verified. This pass repairs only Review resolution. It
does not declare the foundation frozen.

**Correction of the previous status.** The previous pass reported the review generation fence as
complete. It fenced the owner's _advance_ and _close_, i.e. after the domain writes: a stale owner
could still change canonical state and only then receive its `ConflictError`.

| Finding                                                  | Result | Fix                                                                                                                                                                                                                                                                                                                            | Evidence (`review-resolution.int.test.ts`; mutation)                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B3-A** stale resolver executes domain effects          | FIXED  | Every canonical write of a decision commits in ONE transaction with its result, and the transaction's first write is a compare-and-set on the operation (`generation = G, state = claimed`); `retry`'s external run launch is preceded by an ownership check and keyed per item; close fenced on G; lease renewal every minute | Codex probe (A pauses before its write, B recovers, R2 sets `onsite`, A resumes): A gets 409, canonical `onsite` by R2, A cannot finalize. Effect fence removed (effect-then-check) → canonical becomes `remote` by A. Generation removed from the effect fence / close / takeover → the stale owner writes / closes / steals |
| **B3-A** long-running `apply` recoverable while healthy  | FIXED  | Heartbeat renews `owner.at` every `REVIEW_HEARTBEAT_MS` (fenced on the generation); takeover requires the lease still expired at the compare-and-set                                                                                                                                                                           | Owner paused past two stale windows (1.5 s lease in the test) keeps generation 1; sweep and another resolver cannot take over; the owner completes. Heartbeat disabled → takeover                                                                                                                                             |
| **B3-B** invalid decisions persisted and poison the item | FIXED  | Validation before the claim (shape + every precondition checkable now, incl. `create_new` identity clash and override value validity); a deterministic failure after the claim marks the operation `failed` and releases the item (`lastFailure`); transient failures stay claimed (`lastError`)                               | Target not a candidate, missing target, unsupported field/value/action, `create_new` clash → rejected, no operation, item open, a correct decision then succeeds. Clash after claim → released, nothing committed, next generation succeeds. Validation removed / release removed → tests fail                                |
| **B3-B** recovery retries a bad decision; sweep aborts   | FIXED  | Recovery releases a deterministically failing stored decision; each operation is recovered in isolation (logged, counted, recorded, sweep continues); sweep reads only live operations (`by_state_owner_at`, oldest lease first); `recoveredFrom` bounded to 20                                                                | Persisted bad decision → released by the sweep, not retried. One op failing on every sweep does not block another; 26 failing sweeps → `recoveredFrom` length 20. Isolation removed → the other operation is not recovered                                                                                                    |

Mutation checks (each applied alone, the B-3 suite run, then restored):

| Mutation                                                   | Failing regressions                          |
| ---------------------------------------------------------- | -------------------------------------------- |
| Effect-level fence removed (effects committed, then check) | Codex probe; stale owner paused before apply |
| Generation dropped from the effect fence                   | stale owner paused before apply              |
| Generation dropped from the close fence                    | stale owner paused before close              |
| Generation dropped from the takeover compare-and-set       | takeover decided on an outdated read         |
| Validation before the claim removed                        | 7a, 7b, 8, 8b, 9a                            |
| Release of failed decisions removed                        | 9b, 9c                                       |
| Lease renewal (heartbeat) disabled                         | slow but healthy owner keeps its claim       |
| Per-operation isolation in the sweep removed               | 11, 9c                                       |

### Validation (this pass, Docker Compose stack)

| Step                                                                      | Result                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `format:check`, `lint`, `typecheck`, `check:deps`, `check:arch`, `build`  | pass                                                                                             |
| `pnpm test` (unit)                                                        | 616 passed, 47 files                                                                             |
| `pnpm eval:golden`                                                        | 78/78                                                                                            |
| B-3 suite (`review-resolution.int.test.ts`, 22 tests)                     | **10 consecutive green runs**                                                                    |
| Full non-browser integration (runtime 32 + Market/API 68 = 100, 10 files) | **5 consecutive green runs** (the runtime suite is part of each)                                 |
| Browser security suite                                                    | 21 passed, 0 skipped — **2 consecutive green runs** (Chromium 1194 via the unprivileged wrapper) |
| Unhandled rejections, Mongo transaction errors, Redis leaks in any run    | none (the only `ECONNREFUSED` is the runtime gate's simulated Redis outage)                      |
| Recovery sweep query plan (5,000 completed/failed + 7 live operations)    | `IXSCAN by_state_owner_at` (SORT_MERGE): 7 keys and 7 documents examined                         |

GitHub CI on `b0f26b8` (code + tests of this pass): [run 36385746224](https://github.com/mateeqazam/aptamind/actions/runs/36385746224),
job `checks` green on all 16 steps — unit 616, runtime 32, browser 21, Market/API 68 (7 files).

### Remaining limitations (B-3)

_Superseded by the final two-blocker repair above: the first two limitations were the blockers
B3-R1 and B3-R2 and are fixed._

- The source run launched by `retry` is the one effect outside MongoDB. It is keyed per review
  item and preceded by an ownership check, so at most one retry run per item can ever exist.
  An owner frozen for longer than the stale window **between** that check and the launch
  could still start it after losing its generation — observable only if its decision was
  meanwhile released and the item re-decided differently.
- Derived recompute (reconciliation) after the fence is not itself transactional with it: a stale
  owner that passed its last check recomputes derived fields from current canonical inputs,
  exactly as automation does. Company reconciliation is last-writer-wins (pre-existing,
  unchanged by this pass); job reconciliation is revision-CAS'd.
- An internal (non-domain) error in that recompute keeps the operation `applied` and retried each
  stale window (`lastError` visible) instead of closing the item.

## Final repair pass — re-audit of `1b721b7`

An independent re-audit of the hardening head `1b721b7` returned **FAIL — do not freeze
foundation** with four remaining release blockers/highs and two medium items. The architecture
was accepted; this pass repairs those defects without redesign, promotes every re-audit probe
to a permanent regression, and was mutation-checked. It does not declare the foundation frozen.

### Closure matrix

| Finding                                              | Result                                                        | Fix                                                                                                                                                                                                                                                                                  | Evidence (permanent tests; mutation)                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H-1** completion fencing by attempt generation     | FIXED                                                         | Typed lease tokens (`AttemptFence`, `ChunkLease`); every worker-authoritative node and chunk write is fenced on state + owner + attempt/generation                                                                                                                                   | `runtime-gate.int.test.ts`: same worker id, two attempts (renew, finish ×2, scheduleRetry, suspend, enterFanout, recordInput rejected); same worker id, two chunk claims (renew, append, complete, cancel rejected). Attempt predicate removed → each probe fails           |
| **B-2** verification replay after fence expiry       | FIXED                                                         | Lifetime fence on the retained operation record: `lifecycleApplied` set in the same transaction as the job's revision CAS; the bounded job-embedded list is no longer used                                                                                                           | `replay-safety.int.test.ts`: V1 applied, crash, 60 newer operations, V1 replayed → `POSSIBLY_STALE`, `consecutiveNotFound` 1. Fails with `CLOSED` on the audited code and with the durable fence removed                                                                    |
| **B-3** review retry / recovery idempotency          | FIXED in part — reopened (B3-A, B3-B), see _B-3 final repair_ | Durable review operation: stored decision, stable effect identities (`review:<item>:retry` run key), result persisted before advancing, generation fence **on advancing only (effects were not fenced — corrected below)**, transactional close, audit/resume outbox, recovery relay | Retry crash after launch → one source run; audit crash → one audit event; resume crash → workflow resumes once (still valid; now in `review-resolution.int.test.ts`). The claim that a stale owner could not act was wrong: it could write domain state before its conflict |
| **M-5** company observation replay chronology        | FIXED                                                         | `sourceObservedAt` (snapshot fetch time, `$max` only) separate from processing time; supersession by (source time, id); reconciler recency on source time                                                                                                                            | `company-reconcile-scale.int.test.ts`: S1/v1, S2/v2, reprocess S1 → v2 current and canonical; A→B→A re-fetch; concurrent older/newer; deterministic ties. Replay-time chronology → replay and concurrency probes fail with the audited regression                           |
| Found in this pass: delisting marker on reprocessing | FIXED                                                         | Complete-import marker = imported snapshot's source time, `$max`; delisting compares source times                                                                                                                                                                                    | `market.int.test.ts` (M5 reprocessing): reprocessing t1 after t2 keeps t2-only sponsors listed. Processing-time marker → fails                                                                                                                                              |
| **H-3 follow-up** source-health telemetry semantics  | FIXED                                                         | Logical per-run counters (`stats.*`, `health.consecutiveFailures`), counted once via `market_source_run_outcomes` markers in the same transaction                                                                                                                                    | `ack-replay.int.test.ts` compares source stats with the fault-free baseline (1 sponsor run, 3 ATS runs). Counting every call → 6/6 instead of 3/3                                                                                                                           |
| Browser test portability                             | FIXED                                                         | Exported `BROWSER_LAUNCH_POLICY` asserted on every platform; live seccomp/`/proc` check Linux-only (runs on CI); held page always released in `finally`                                                                                                                              | Browser suite 21/21; simulated non-Linux 21/21; simulated assertion failure → clean teardown, no unhandled error                                                                                                                                                            |

### Validation (fresh Docker Compose stack)

Fresh stack (`docker compose down -v && docker compose up -d --wait`), Chromium 1194 sandboxed
through the privilege-dropping wrapper:

| Step                                                             | Result                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                 | pass                                                                       |
| `format:check`, `lint`, `typecheck`, `check:deps`, `check:arch`  | pass                                                                       |
| `pnpm test` (unit)                                               | 616 passed, 47 files                                                       |
| `pnpm eval:golden`                                               | 78/78                                                                      |
| Full integration (`vitest --project integration`, incl. browser) | 107 passed, 10 files, 0 skipped — **5 consecutive green runs**             |
| Non-browser integration within it                                | 86 per run (runtime/gate/transport 32, Market/API 54)                      |
| Runtime suite (runtime + F1 gate + transport)                    | 32 passed — **5 consecutive green runs**                                   |
| Browser security suite                                           | 21 passed, 0 skipped — 2 consecutive green runs (plus the earlier repeats) |
| `pnpm build`                                                     | pass                                                                       |
| Unhandled rejections / Redis connection leaks in any run         | none                                                                       |

GitHub CI on the final-repair code (`d78f6cc`): [run 36377888845](https://github.com/mateeqazam/aptamind/actions/runs/36377888845),
attempt 2, green on all 16 steps (attempt 1 was never started by GitHub: an Actions billing
block, since resolved by the owner).

### Live smoke

`pnpm smoke:live` from this environment: GOV.UK, Greenhouse, Ashby and Lever — **NOT
REACHABLE** (egress policy 403). The re-audit verified them live independently; here they are
**FIXTURE VERIFIED** only.

## Independent audit — hardening status

An independent audit of `f9dd9f4` concluded **FAIL — do not use as shared foundation**. The
hardening branch repairs every BLOCKER and HIGH finding and the listed MEDIUM findings. Every
fix has a test that fails on the audited code; the concurrency and replay fixes were also
mutation-checked (the fence or guard removed → the test fails). This section records evidence
for re-audit; it does not declare the foundation frozen.

### Finding closure matrix

| Finding                                                    | Status                              | Fix                                                                                                                                                                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-1** listing absence not crash/replay idempotent        | FIXED                               | Per-job, per-source listing marks written in the same revision-CAS update as the absence; replayed/older snapshots skipped; revision CAS on every job write                                     | `replay-safety.int.test.ts` B-1 (crash mid-apply + replay, concurrent replays of one listing, ack-failure retry); 3 failures under mutation                                                                                                                                                                                                                                                                      |
| **B-2** verification replay double-applies                 | FIXED                               | Verification as an operation (claim → check → persist → fenced apply → complete) with a deterministic id; `lifecycle.appliedVerifications` fence                                                | `replay-safety.int.test.ts` B-2: crash at 5 boundaries (before/after claim, after persistence, after lifecycle application, before acknowledgement) + concurrent replays; fence mutation caught                                                                                                                                                                                                                  |
| **B-3** concurrent review resolution                       | Superseded — see _B-3 final repair_ | Atomic claim model; owner-only mutation; 409 `ConflictError`; `Idempotency-Key` → operation id; stale-claim recovery completes the stored decision (ADR-0017)                                   | Barrier race, owner resume after crash, abandoned-claim recovery, 8 concurrent resolvers — now in `review-resolution.int.test.ts`                                                                                                                                                                                                                                                                                |
| **B-4** browser SSRF and `--no-sandbox`                    | FIXED                               | `SafeEgressProxy` (resolve once, validate, connect to validated IP) for all browser traffic; Chromium sandbox always on; no fallback; privilege-dropping wrapper for root containers (ADR-0016) | `browser.int.test.ts` 21 tests (private/loopback/IPv6/metadata/`file:`, redirects, private resolution, subresources/TLS tunnels/WebSockets, DNS rebinding, live renderers under seccomp and without `--no-sandbox`, root refusal); proxy mutation → 5 failures, sandbox mutation → 2                                                                                                                             |
| **H-1** `beginAttempt` not lease-fenced                    | FIXED                               | Fenced pipeline update for attempt start; `holdsLease` before `execute`; fenced input recording, chunk items and chunk cancellation                                                             | `runtime-gate.int.test.ts` _lease fencing (H-1)_: stale worker at attempt start, after attempt start, stale chunk worker; each fence mutation caught                                                                                                                                                                                                                                                             |
| **H-2** work model misreads preference/anti-fit statements | FIXED                               | Statement stance (`role`/`company`/`preference`/`anti_fit`), clause splitting, lead-ins, structured-conflict and anti-signal flags                                                              | 9 new golden cases incl. the live Ashby regression (`ashby-remote-preference-not-onsite`); 6 fail on the audited code                                                                                                                                                                                                                                                                                            |
| **H-3** idempotency contract untyped/unenforced            | FIXED                               | Discriminated `pure`/`key`/`natural`/`no_retry` contract enforced at registration; proofs; generated matrix; ack-retry budget; AI operation ledger for `propose_job_requirements` (ADR-0015)    | `registry.test.ts`, `retry-policy.test.ts`; `ack-replay.int.test.ts` (ack failure injected after every Market side-effecting node → state identical to baseline, one AI call); [capability-idempotency.md](../architecture/capability-idempotency.md)                                                                                                                                                            |
| **H-4** no `main`, CI not gating                           | PARTIAL — owner action required     | CI runs on PRs to `main` and pushes to `main`: format, lint, typecheck, deps, arch, unit, golden, Compose integration (runtime, browser, Market/API), stray-test guard, build                   | `main` created at `f9dd9f4`; PR [mateeqazam/aptamind#1](https://github.com/mateeqazam/aptamind/pull/1) → `main`: CI run [36340856148](https://github.com/mateeqazam/aptamind/actions/runs/36340856148) green on `71f00aa`, all 16 steps. Still open (owner action): make `main` the default branch and require the `checks` job of the `CI` workflow as a status check in branch protection in branch protection |
| **M-1** crash-takeover test nondeterministic               | FIXED                               | SIGKILL only after the child signals `started`; the running attempt is asserted before the kill                                                                                                 | `runtime.int.test.ts` _SIGKILL takeover_; runtime suite repeated (see validation)                                                                                                                                                                                                                                                                                                                                |
| **M-2** compensation currency/open-ended/bonus             | FIXED                               | Explicit currency code wins; `+` means minimum only; bonus idioms are not pay                                                                                                                   | 7 new golden cases (5 fail on the audited code) + `salary.test.ts`                                                                                                                                                                                                                                                                                                                                               |
| **M-3** no runtime Mongo validation                        | FIXED                               | `$jsonSchema` validators derived from Zod for every collection; insert-time Zod validation in stores/services (ADR-0018)                                                                        | `json-schema.test.ts`; `schema-validation.int.test.ts` (11 collections: real documents accepted, invalid insert and update rejected by the server)                                                                                                                                                                                                                                                               |
| **M-4** bind guard fail-open                               | FIXED                               | Production requires an explicit loopback/private IP; hostnames, `0.0.0.0`, `::`, public IPs refused unless the acknowledgement phrase is set                                                    | `config.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                 |
| **M-5** company reconciliation unbounded/truncating        | FIXED                               | Supersession of older record versions (race-safe protocol); reconciler reads current observations + distinct historical names                                                                   | `company-reconcile-scale.int.test.ts`: 3,000 observations → 100 current, 27–31 ms (before: 3,000 current, 2,000 read with truncation, 173 ms); concurrent-writer test (fails without the check-after-write step)                                                                                                                                                                                                 |
| Found during validation: queue worker shutdown             | FIXED                               | Close a worker only once ready; release its own Redis connection                                                                                                                                | `runtime-transport.int.test.ts` (fails on the audited code: 82 open connections instead of 2); intermittent unhandled rejections in repeated runs gone                                                                                                                                                                                                                                                           |

### Hardening validation (this environment, Docker Compose)

Fresh stack (`docker compose down -v && docker compose up -d --wait`: `mongo:7` replica set,
`redis:7-alpine`, `chrislusf/seaweedfs:4.47`), then in sequence. Chromium 1194 runs sandboxed
through `scripts/chromium-unprivileged.sh`.

| Step                                                    | Result                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                        | pass                                                                                                                                               |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`      | pass                                                                                                                                               |
| `pnpm check:deps`, `pnpm check:arch`                    | pass                                                                                                                                               |
| `pnpm test` (unit)                                      | 616 passed, 47 files                                                                                                                               |
| `pnpm eval:golden`                                      | 78/78 (16 new hardening cases: 9 work model, 7 compensation)                                                                                       |
| Full integration suite (`vitest --project integration`) | 93 passed, 10 files, 0 skipped — **5 consecutive green runs**, no unhandled errors                                                                 |
| Runtime + F1 gate + transport (CI step)                 | 30 passed — **5 consecutive green runs**                                                                                                           |
| Browser security suite (CI step)                        | 21 passed, 0 skipped (as root here; the sandbox tests have a root and a non-root path, so none skip on CI's non-root runner) — repeated green runs |
| `pnpm build`                                            | pass                                                                                                                                               |

An earlier round of the same sequence surfaced intermittent unhandled Redis rejections (2 of
3 full runs, 1 of 3 runtime runs, all tests passing). They were root-caused to the queue
worker shutdown bug listed in the matrix, fixed and covered before the green runs above.

### Live integrations

`pnpm smoke:live` (read-only GETs; never part of CI) was run from this environment: GOV.UK,
Greenhouse, Ashby and Lever all returned **403 from the environment's egress policy** — NOT
EXERCISED. Everything external is **fixture-verified only**; the Ashby H-2 case is a
reproduction of a live posting, not a live fetch. An owner can run `pnpm smoke:live` from a
machine with internet access (or allow those hosts in this environment's network settings).

## F1 acceptance gate — architecture and reliability audit

Performed before continuing into M1–M5. Every item was checked against the code; problems
found were fixed and covered by automated tests.

### Findings and fixes

| #   | Finding                                                                                                                                                                                                          | Fix                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `engine.ts` (1,663 lines) implemented graph evaluation, persistence, leases, retries, timeouts, cancellation, fan-out, subworkflows, outputs and dispatch itself; policies could not be unit-tested in isolation | Refactored into cohesive components (ADR-0013): pure `graph`, `retry-policy`, `state-machine`, `triggers`; `RunStore`/`NodeRunStore`/`ChunkStore`; `NodeExecutor`, `ExecutionGuard`, `FanoutCoordinator`, `SubworkflowRunner`, `CancellationCoordinator`, `NodeOutputStore`, `WakeUps`. `engine.ts` is now a 398-line orchestrator; public API unchanged. |
| 2   | Capabilities received the whole engine through their context                                                                                                                                                     | `CapabilityEnvironment` (services, artifacts, subworkflows) and a narrow `RunDriver` port; no component holds the engine                                                                                                                                                                                                                                  |
| 3   | A failed BullMQ dispatch after a committed Mongo write propagated as an error (e.g. `startRun` failing while the run existed)                                                                                    | Wake-ups are best-effort (`WakeUps`): logged + `workflow_dispatch_failures_total`, recovered by the sweeper                                                                                                                                                                                                                                               |
| 4   | A failure while persisting a finished attempt was classified by the capability's own retry default (a non-retryable capability could be failed after its work succeeded)                                         | `AcknowledgementError` (retryable within a separate budget; safe because of the capability idempotency contract, ADR-0015)                                                                                                                                                                                                                                |
| 5   | Takeover detection relied on a pre-claim read; attempt durations were not recorded                                                                                                                               | Takeover is derived from the claimed document's `running` attempts; every closed attempt records `durationMs`                                                                                                                                                                                                                                             |
| 6   | Market vocabulary in the generic runtime: a `labels.sourceId` index, a `sourceId` read-model filter, hard-coded `sourceId/companyId/jobId` log labels                                                            | Generic label filter and `*Id` label correlation; the index moved to the composition root (platform migration `2026-09-27-003`)                                                                                                                                                                                                                           |
| 7   | `@aptamind/market` declared the engine as a production dependency (only its test harness uses it); layering was lint-only and the ESLint domain block silently dropped the deep-import rule for shared packages  | Engine moved to Market's devDependencies; `scripts/check-architecture.ts` (`pnpm check:arch`, in `pnpm check` + CI) enforces an explicit per-package allow-list from manifests and imports, confines BullMQ to the adapter/worker host, and keeps pure modules I/O-free; ESLint fixed                                                                     |
| 8   | `docker-compose.yml` and CI used `minio/minio`, which no longer exists on Docker Hub — the Docker path could not start on a clean machine                                                                        | S3 service switched to SeaweedFS (ADR-0014); CI now uses the same compose file; full suite and app smoke test verified on the Compose stack                                                                                                                                                                                                               |
| 9   | Local-infra script and docs pointed at conda/micromamba install paths                                                                                                                                            | Docker Compose documented as the supported path; the native script is an optional fallback that uses binaries on PATH and prescribes no installer (ADR-0012 amended)                                                                                                                                                                                      |

### Requirement coverage (direct automated evidence)

`gate` = `packages/testing/src/runtime/runtime-gate.int.test.ts`, `runtime` =
`packages/testing/src/runtime/runtime.int.test.ts`, unit tests next to the modules.

| Requirement                                                               | Evidence                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit → new immutable WorkflowVersion; old runs stay linked to the old one | gate _versioning_: v1 document byte-identical after v2 is registered; r1 keeps `versionId`/`workflowVersion`; a historical version can still be executed                                                               |
| Each NodeRun records the exact capability type/version                    | gate _versioning_: `test.echo@1` vs `@2` recorded per node run and in `run.capabilityVersions`                                                                                                                         |
| Restart durability A → B → C, completed work not rerun                    | gate _durability_: process 1 completes A, B and dies during C with no transport jobs; process 2 resumes at C; A/B executed once and not re-claimable even when re-delivered (mutation-checked)                         |
| Failure after side effect, before acknowledgement → one durable effect    | gate _durability_: failed completion write (fault injection) and worker death after the effect; exactly one effect document; runtime _SIGKILL takeover_ with a real child process                                      |
| 100 records at concurrency 10, lineage and aggregates inspectable         | gate _fan-out_: max in-flight/active chunks/simultaneous executions ≤ 10 (mutation-checked: 93 without the slot guard); counters, outputs, chunk → item indexes; 100 child runs linked by `parent.nodeRunId/itemIndex` |
| Retryable vs terminal, bounded attempts, backoff, timeout, history        | gate _retry semantics_ (4 tests) + `retry-policy.test.ts`; runtime _retries_, _terminal + operator retry_, _timeout_                                                                                                   |
| Large/raw content via ArtifactRef; store/load, hash/size/mime, integrity  | gate _artifacts_: 100 KB output offloaded (`outputRef`, sha256/size/mime, context labels), downstream reads full content, dedupe by hash, tampering detected; runtime _artifact reprocess without refetch_             |
| BullMQ transport only; Redis outage does not hide completed state         | gate _transport_: queues obliterated + failing dispatcher → run detail, node runs, attempts and listings readable; new run accepted durably; completes once Redis is back; runtime _Redis flush_                       |
| Generic runtime independent of Market                                     | `pnpm check:arch` + ESLint; runtime never names domain labels                                                                                                                                                          |
| Graph evaluation, state transitions, guard (timeout/cancel/lease loss)    | `graph.test.ts`, `state-machine.test.ts`, `execution-guard.test.ts`                                                                                                                                                    |
| Cancellation, conditional branches, wait/resume, subworkflows, schedules  | runtime integration tests (unchanged, passing on the refactored engine)                                                                                                                                                |

### Remaining limitations (runtime)

- Execution is at-least-once. Registration enforces that every capability declares and
  justifies a strategy (`pure`/`key`/`natural`/`no_retry`, ADR-0015), but the runtime cannot
  prove a written `idempotencyProof` true; correctness rests on the proofs and the replay tests.
- Inline subworkflows (and fan-out workflow bodies) occupy the parent's worker slot; items
  inside a chunk run sequentially.
- Redis-outage tests simulate the outage with a failing dispatcher plus obliterated queues
  rather than killing Redis mid-test; readiness endpoints report Redis as down in a real outage.
- Dispatch failures are recovered by the sweeper after `staleDispatchMs` (default 60 s), so
  work started during an outage begins up to that long after Redis returns.

## Definition of Done (context doc §30)

| #   | Criterion                                                                       | Status                                                                                              |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | Source registered and triggered manually or on schedule                         | ✅ (`POST /api/sources/:id/run`, source schedules via runtime scheduler)                            |
| 2   | Generic workflow executes through durable run/node state                        | ✅                                                                                                  |
| 3   | Fetch results preserved as raw artifacts                                        | ✅                                                                                                  |
| 4   | Observations, not direct canonical overwrites                                   | ✅                                                                                                  |
| 5   | Company resolution reuses/creates, reviews ambiguity                            | ✅                                                                                                  |
| 6   | Canonical company facts retain provenance/confidence                            | ✅                                                                                                  |
| 7   | UK sponsor workflow rerun idempotently                                          | ✅ (fixture server; see "integrations" below)                                                       |
| 8   | Careers/ATS discovery creates reusable job sources                              | ✅                                                                                                  |
| 9   | Greenhouse, Ashby, Lever ingest job observations                                | ✅ (fixture payloads of the public APIs)                                                            |
| 10  | Canonical jobs dedupe copies and keep lifecycle history                         | ✅                                                                                                  |
| 11  | Verification distinguishes live / possibly stale / closed                       | ✅                                                                                                  |
| 12  | Work model / remote scope / restrictions beyond a boolean                       | ✅                                                                                                  |
| 13  | Company sponsor capability distinct from role sponsorship                       | ✅                                                                                                  |
| 14  | Ambiguity/conflict creates review items                                         | ✅                                                                                                  |
| 15  | Admin inspects sources, companies, jobs, runs, errors, review                   | ✅                                                                                                  |
| 16  | Restarts/retries do not corrupt or duplicate state                              | ✅ (API restart, worker SIGKILL, interrupted A→B→C, lost ack, Redis loss/outage, retries — F1 gate) |
| 17  | Unit tests for core policies; integration tests for vertical slices             | ✅                                                                                                  |
| 18  | Golden fixtures for resolution, lifecycle, remote/location, sponsorship, salary | ✅ (78 cases)                                                                                       |
| 19  | AI structured output schema-validated and version-traceable                     | ✅ (fixture provider in tests; no live provider call)                                               |
| 20  | Docs for capabilities, connectors, workflow templates                           | ✅ (`docs/guides/`)                                                                                 |
| 21  | No authentication code                                                          | ✅ (only the actor seam)                                                                            |
| 22  | No Professional/Opportunity dependency                                          | ✅                                                                                                  |

## Verification results at the audited commit `f9dd9f4` (historical)

| Command                                            | Result                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass                                                                                                                   |
| `pnpm check:deps`, `pnpm check:arch`               | pass (architecture check also verified to fail on planted violations)                                                  |
| `pnpm test` (unit)                                 | 547 tests pass                                                                                                         |
| `pnpm eval:golden`                                 | 62/62 cases pass (company resolution 12, job resolution 7, lifecycle 11, reconciliation 4, employment intelligence 28) |
| `pnpm test:integration`                            | 42 tests pass (runtime 13, F1 gate 13, headless browser 1, market 14, API 1)                                           |
| `pnpm build`                                       | api + worker bundles, admin production build succeed                                                                   |
| Built API + worker on the Compose stack            | migrate, demo seed (5 runs completed, 16 companies, 14 jobs), `/ready` green, source run history via label filter      |

Infrastructure used: **Docker Compose** (`mongo:7` replica set, `redis:7-alpine`,
`chrislusf/seaweedfs:4.47`) for the full integration suite and the app smoke test; the gate
suite was additionally run against the native fallback (`scripts/local-infra.sh` with
`mongod` 7.0, `redis-server` 7 and `weed`). Chromium 1194 (pre-installed Playwright build).

## Real integrations vs fixtures

| Integration                              | Exercised against                                         | Live?                                                                                 |
| ---------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| MongoDB, Redis/BullMQ, S3 (SeaweedFS)    | real local services (Docker Compose)                      | yes (local)                                                                           |
| Headless Chromium (`core.browser_fetch`) | real browser against local pages                          | yes (local)                                                                           |
| UK sponsor register (gov.uk)             | committed CSV/HTML fixtures via local HTTP server         | **no** — outbound access to gov.uk is blocked in this environment                     |
| Greenhouse / Lever / Ashby public APIs   | committed fixtures reproducing documented response shapes | **no** — provider hosts are blocked here                                              |
| Third-party job feed                     | synthetic fixture                                         | n/a                                                                                   |
| Anthropic (AI gateway)                   | deterministic fixture provider                            | **no** — no API key; provider code typechecks against the SDK but was not called live |

## Known limitations

- Live-network paths (gov.uk, ATS APIs, Anthropic) are implemented but unverified against the
  real services from this environment; first live runs should be watched (source health,
  `parser_failure` reviews).
- Rate limiting is per process (ADR-0006). Company reconciliation reads current observations
  only; supersession applies to records with an external id or locator (records without one
  stay current and are not collapsed). Inline subworkflows occupy a worker slot while they run (ADR-0003).
  See the F1 gate section for runtime-specific limitations.
- Interpretation is rule-based: wording outside known patterns stays `unclear`/unknown (by
  design) and some office-location attribution is approximate.
- "City, XX" with an unknown city and a two-letter code that is also a US state resolves to the
  US state.
- No retention/deletion policy for artifacts yet; no signal ingestion (schema/API seam only).
- No authentication — the API/admin must stay on a private network.

## Follow-up work outside the locked programme

Authentication/authorization at the API edge (`resolveActor`), live monitoring of the first
real source runs, Redis-backed distributed rate limiting, artifact retention policies, signal sources, more ATS providers,
evaluation of AI extraction quality with real credentials, OpenTelemetry exporter wiring.
