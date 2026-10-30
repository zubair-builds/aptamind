# Workflow runtime

`packages/workflow-sdk` (contracts) + `packages/workflows` (engine) + `packages/workflow-nodes`
(generic capabilities). The runtime is Aptamind-wide and domain-agnostic: it executes versioned
capabilities with typed contracts and knows nothing about companies, jobs, CVs or repositories.

## Concepts

| Concept                                  | Where                                       | Notes                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CapabilityDefinition`                   | `workflow-sdk/src/capability.ts`            | `type@version`, Zod `configSchema`/`inputSchema`/`outputSchema`, execution contract (`sideEffects` + `idempotency` strategy + proof, `retryable`, timeout, `queue`, `mode`). |
| `WorkflowSpec`                           | `workflow-sdk/src/workflow-spec.ts`         | Code-authored DAG: nodes (capability ref, config, input template, retry, timeout), edges (optional `when.branch`), optional `outputNode`, labels, default schedule.          |
| `WorkflowDefinition` / `WorkflowVersion` | `workflow_definitions`, `workflow_versions` | Registering a spec is idempotent; a changed spec (content hash) creates version N+1. Versions are immutable and cached.                                                      |
| `WorkflowRun`                            | `workflow_runs`                             | Input, trigger, labels, exact `capabilityVersions` per node, state, output (inline or artifact), lineage (`parent`, `rootRunId`, `depth`), `idempotencyKey`.                 |
| `NodeRun`                                | `workflow_node_runs`                        | One per (run, node). State, lease, attempts history, resolved input (truncated), output (or `outputRef` when > 64 KB), logs (last 200), wait info, fan-out counters.         |
| Fan-out chunk                            | `workflow_fanout_chunks`                    | Batches of for-each items with per-item results.                                                                                                                             |
| Schedule                                 | `workflow_schedules`                        | Cron or interval, owner (e.g. a source), next fire time — evaluated from Mongo.                                                                                              |

## Module structure

`WorkflowEngine` (`engine.ts`) is an orchestrator: it advances runs (graph evaluation →
persistence → wake-ups) and exposes operator actions; everything else is a component with an
explicit interface (ADR-0013).

```text
                    ┌──────────── WorkflowEngine (RunDriver) ────────────┐
 trigger ─► triggers.ts ─► RunStore            graph.ts (pure) ◄── advanceRun
                               │                     │
 transport ─► NodeExecutor ─► NodeRunStore ◄─────────┘        WakeUps ─► Dispatcher ─► BullMQ
               │  │   │          ▲  (lease-fenced attempts)
               │  │   └─ retry-policy.ts (pure)   ExecutionGuard (timeout/heartbeat/abort)
               │  └──── CapabilityRegistry ─► capability.execute(ctx: services, artifacts, subworkflows)
               ├──────── FanoutCoordinator ─► ChunkStore (slots, transactional completion)
               ├──────── SubworkflowRunner (inline, durable child runs)
               ├──────── CancellationCoordinator
               └──────── NodeOutputStore ─► ArtifactStore (outputs > 64 KB by reference)
```

| Module                          | Responsibility                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `catalog.ts`                    | Register specs; immutable content-hashed versions                                 |
| `triggers.ts`                   | Pure: build the run document (pinned version, exact capability versions, lineage) |
| `graph.ts`                      | Pure: which nodes run/skip next; run outcome; output node                         |
| `state-machine.ts`              | Pure: legal run/node transitions (used as Mongo update guards)                    |
| `retry-policy.ts`               | Pure: retry vs final, attempt budget, backoff                                     |
| `stores/*.ts`                   | The only code that writes runs, node runs and chunks                              |
| `node-executor.ts`              | Claim → resolve capability → validate → execute under a guard → persist → advance |
| `execution-guard.ts`            | Timeout, lease heartbeat, cancellation/lease-loss abort                           |
| `fanout.ts`, `subworkflows.ts`  | Bounded fan-out; inline durable child runs                                        |
| `cancellation.ts`               | Two-phase cancellation                                                            |
| `outputs.ts`                    | Inline vs artifact-referenced inputs/outputs                                      |
| `transport.ts`, `dispatcher.ts` | Best-effort wake-ups; the BullMQ adapter                                          |
| `scheduler.ts`, `sweeper.ts`    | Mongo-driven schedules; recovery                                                  |
| `queries.ts`                    | Read models                                                                       |
| `worker-host.ts`, `runtime.ts`  | Process wiring                                                                    |

Boundaries are checked by `pnpm check:arch`: the runtime packages never depend on a domain
package, only the adapter/worker host import the queue, and the pure modules import no I/O.

## Input templates (no code evaluation)

Node inputs are JSON with `{ "$ref": "<path>", "default"?: <json> }` leaves:
`run.input.*`, `run.labels.*`, `trigger.*`, `nodes.<upstream>.output.*`, `item`, `item.*`,
`itemIndex`. References to non-upstream nodes are rejected at registration. There is
deliberately no expression language and no arbitrary code node; source-specific logic is a
registered code capability (see ADR-0003).

## Execution model

1. `startRun` inserts the run (idempotent on `idempotencyKey`) and calls `advanceRun`.
2. `advanceRun` creates node runs whose predecessors are all terminal: a node runs if at least
   one incoming edge is _active_ (predecessor `COMPLETED` and its `output.branch` matches
   `when.branch`, if any); otherwise it is `SKIPPED`. Creation is keyed by (run, node), so
   concurrent advancement is harmless. New `QUEUED` nodes are dispatched to BullMQ
   (`wf-node-<queue>`, job id `<nodeRunId>__<dispatchSeq>`).
3. A worker **claims** a node with an atomic `findOneAndUpdate` (`QUEUED`, due
   `RETRY_SCHEDULED`, or `RUNNING` with an expired lease → `RUNNING` with a new lease). A claim
   that fails means someone else owns it: duplicate deliveries are no-ops.
   The claim is followed by a **lease-fenced** `beginAttempt` (see _Lease fencing_ below); a
   worker whose fence fails does nothing.
4. The capability runs with a `CapabilityContext` (idempotency key, abort signal, artifacts,
   record sets, services, logger, heartbeat, `suspend`, `runSubworkflow`). A heartbeat extends
   the lease and checks for cancellation.
5. The result is schema-validated and stored (large outputs offloaded to artifacts); the node
   completes only if the lease is still held; then the run advances.

### Delivery semantics

- **MongoDB is authoritative** for runs, node runs, attempts, outputs, errors, versions, chunks
  and schedules. A BullMQ job is a wake-up pointer (`<id>__<dispatchSeq>`), sent only after the
  Mongo write it announces. If sending fails (Redis down), the failure is logged and counted
  (`workflow_dispatch_failures_total`); the node is still `QUEUED` in Mongo and the sweeper
  re-dispatches it. Losing or flushing Redis never loses a run or makes completed state
  unknowable; read models never touch the queue.
- **Execution is at-least-once.** A capability can run more than once for the same logical
  invocation: lease takeover after a crash, a retry after a failure, or a failed
  acknowledgement (the capability succeeded but recording its output failed —
  `AcknowledgementError`). The runtime does **not** make effects exactly-once by itself; each
  capability declares how it stays correct under re-execution (_Idempotency contract_ below),
  and registration rejects capabilities that do not.
- **Completed work is never redone.** A node run exists once per (run, node) and a
  `COMPLETED` node cannot be claimed, so re-deliveries and restarts resume from the first
  unfinished node.

### Idempotency contract (audit H-3)

`CapabilityExecution` is a discriminated union checked at compile time and again at
registration (`executionContractViolation`, `registry.register` throws):

| `sideEffects` | `idempotency` | Requirements                    | Runtime behaviour                                                        |
| ------------- | ------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `false`       | `pure`        | —                               | Re-executed freely (read-only I/O, content-addressed artifacts).         |
| `true`        | `key`         | `idempotencyProof` (≥ 10 chars) | Re-executed; effects keyed on `ctx.idempotencyKey` are reused.           |
| `true`        | `natural`     | `idempotencyProof`              | Re-executed; effects idempotent by deterministic ids / replay markers.   |
| `true`        | `no_retry`    | `retryable: false`              | Never re-executed: no retries, no ack retries, a takeover fails the node |

`ctx.idempotencyKey` is `<runId>:<nodeId>` (or `…:<itemIndex>` inside a fan-out) and is stable
across attempts. A `no_retry` capability whose attempt was interrupted fails with
`UnsafeReexecutionError` (its outcome is unknown; an operator decides), cannot be a `for_each`
body (rejected by `validateWorkflowSpec`) and cannot be operator-retried. The per-capability
matrix, with each proof, is generated into
[`capability-idempotency.md`](capability-idempotency.md) (`pnpm docs:capabilities`).

**Acknowledgement retries.** When a capability succeeded but persisting its output failed, the
attempt is retried as an acknowledgement failure. These retries are budgeted separately
(`ackRetries`, at most `ACK_RETRY_ALLOWANCE` = 2 beyond `maxAttempts`, short backoff) so a
capability configured with `maxAttempts: 1` still survives a transient store error without an
unbounded loop. The replay is safe precisely because of the contract above; the Market
`ack-replay` integration test injects this fault into every Market side-effecting node and
asserts the final state equals the fault-free baseline.

### Lease fencing (audit H-1)

A claim increments the node run's `attempt` (a takeover by the **same** worker id also gets a new
attempt). The claim yields a lease token — `AttemptFence { nodeRunId, workerId, attempt }` — and
**every worker-authoritative write requires that token** and is fenced on
`{ _id, state: 'RUNNING', leaseOwner: workerId, attempt }`. A worker id alone is never
sufficient: after its lease expired, the same worker id may legitimately hold a newer attempt.

| Write                                            | Fence                                     |
| ------------------------------------------------ | ----------------------------------------- |
| `beginAttempt` (close stale `running`, append)   | state + owner + attempt (pipeline update) |
| `holdsLease` (right before `capability.execute`) | state + owner + attempt + unexpired lease |
| `renewLease` (heartbeat), `recordInput`          | state + owner + attempt                   |
| `finish` (COMPLETED/FAILED/CANCELLED)            | allowed from-state + owner + attempt      |
| `scheduleRetry`, `suspend`, `enterFanout`        | state + owner + attempt                   |

A stale token gets `false`/`null` and changes nothing; a worker whose heartbeat is rejected
aborts its capability.

Fan-out chunks have the same model: a chunk claim increments the chunk's `attempt` (its claim
generation) and yields a `ChunkLease { chunkId, workerId, attempt }`. `holdsLease` (before each
item), `renewLease`, `appendResults`, `commitCompletion` (with the parent's counters, in one
transaction) and `markCancelled` are all fenced on `RUNNING` + owner + generation. A chunk runner
stops as soon as a result flush is rejected and never commits a generation it no longer holds.

The independent re-audit probes are permanent tests in `runtime-gate.int.test.ts`: the same
worker id holding attempt 1 and then attempt 2 (stale renew, finish ×2, scheduleRetry, suspend,
enterFanout and recordInput all rejected), and the same worker id holding two chunk claims
(stale renew, append, complete and cancel all rejected). Removing the attempt predicate from
either store makes the corresponding probe fail.

A deterministic crash test (`runtime.int.test.ts`) SIGKILLs a worker child process after its
capability has signalled `started`, then asserts the takeover records the first attempt as
`lost` and completes the node exactly once.

### State machines

```text
Run:   PENDING → RUNNING ⇄ WAITING → COMPLETED | FAILED | CANCELLED
       RUNNING/WAITING → CANCELLING → CANCELLED;   FAILED → RUNNING (operator retry)
Node:  QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED
       RUNNING → RETRY_SCHEDULED → RUNNING …       RUNNING → WAITING → QUEUED (resume)
       RUNNING → FANNING_OUT → COMPLETED | FAILED  FAILED → QUEUED (operator retry)
       (not created) → SKIPPED
```

Transitions are defined in `state-machine.ts` and unit-tested; Mongo updates are guarded by
the allowed "from" states.

### Retries, timeouts, cancellation

- Errors are classified: `RetryableError` / `TerminalError` / capability default. Transient HTTP
  statuses (408/425/429/5xx) are retryable; 4xx are terminal.
- Budget: `maxAttempts` per life; an operator retry adds a life, a resume adds one attempt.
  Attempts are always bounded (`retry-policy.ts`), including repeated lease losses
  (`AttemptsExhausted`).
- Backoff: exponential (`backoffMs · 2^(n-1)`, capped), restarting per life. Attempt history is
  never lost: each attempt records worker, start/finish, duration, status (`failed`,
  `timed_out`, `lost`, `suspended`, `completed`, …) and error.
- Timeouts abort the capability's signal and fail the attempt (`NodeTimeoutError`, retryable per policy).
- Cancellation marks the run `CANCELLING`, cancels pending nodes/chunks immediately and running
  work at its next heartbeat; child runs are cancelled too.
- Operator retry (`POST /api/node-runs/:id/retry`) re-queues a `FAILED` node, extends its
  attempt budget, keeps history and re-opens the run. `no_retry` capabilities cannot be
  retried this way.

### Bounded fan-out (`core.for_each`)

The engine implements `core.for_each` (`execution.mode = 'fanout'`). Items (inline array or a
JSONL **record set** artifact) are split into chunks of `batchSize` and stored once. At most
`concurrency` chunks are in flight, enforced by an atomic `inFlight < concurrency` slot claim;
completing a chunk and decrementing counters happen in one transaction. Items inside a chunk
run sequentially with per-item retries and idempotency key `<nodeKey>:<itemIndex>`. The node
finalises when all chunks are terminal: `failurePolicy` (`continue`/`fail_fast`) and
`maxFailureRatio` decide success; the output reports totals and sample failures (optionally
collected outputs). A 120k-row dataset becomes ~600 chunk documents and never 120k
simultaneous tasks.

### Subworkflows and waiting

- `ctx.runSubworkflow` / `core.execute_subworkflow` / a `for_each` body `workflow` run a child
  workflow **inline** (in-process) while persisting its run and node runs; re-invocation with
  the same idempotency key resumes or returns the same child. Depth is capped (5).
- `ctx.suspend({ kind, reason, correlationKey })` puts a node in `WAITING` (the run becomes
  `WAITING` when nothing else is active). `resumeNodeRun` / `resumeByCorrelationKey` re-queue it
  with `ctx.resume` set. The Market review service resumes nodes waiting on a review item id.
  Resumes do not consume the retry budget.

### Scheduling

`Scheduler.tick()` finds due schedules in Mongo, starts a run with idempotency key
`schedule:<id>:<scheduledFor>` **before** advancing `nextFireAt` (guarded compare-and-set).
Concurrent schedulers or a crash between the two steps cannot create duplicate runs. Sources own
schedules (`owner = { kind: 'source', id }`), kept in sync by `SourceService.syncSchedule`.

### Recovery sweeper

Runs periodically in every worker (`WORKER_SWEEPER_INTERVAL_MS`) and makes Mongo the source of
truth for what must run: re-dispatches `QUEUED` nodes whose transport job disappeared, expired
`RUNNING` leases, overdue retries, stale chunks; repairs fan-out slot accounting only when the
fan-out is quiet (compare-and-set, so the concurrency bound is never exceeded); finalises
completed fan-outs; advances runs whose advancement was interrupted; fails waits past their
`timeoutAt`.

## Observability

- Logs (pino) carry `workflowRunId`, `nodeRunId`, `workflowKey` and every `*Id` run label
  (e.g. a domain's `sourceId`) via async context; node logs are also stored on the node run
  (last 200 entries).
- Metrics: `workflow_runs_started_total`, `workflow_runs_finished_total{state}`,
  `workflow_run_duration_ms`, `workflow_node_runs_total{capability,status}`,
  `workflow_node_duration_ms`, `workflow_node_retries_total`,
  `workflow_node_lease_takeovers_total`, `workflow_fanout_items_total`,
  `workflow_dispatch_failures_total`,
  `queue_job_failures_total`, `api_requests_total`, `ai_calls_total`, … at `/metrics`.
- Read models: `WorkflowQueries` (runs filtered by workflow/state/labels/parent, run detail
  with node graph, chunk stats, child counts, artifacts, stats) behind `/api/runs*`. Indexes
  for domain labels are created by the composition root, not the runtime.
- Tracing: `withSpan` uses the OpenTelemetry API (no-op until an SDK is registered).

## Generic capabilities

| Type                                                    | Purpose                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `core.manual_trigger`, `core.schedule_trigger`          | Entry nodes (expose run input / scheduled time)                        |
| `core.http_request`                                     | SSRF-safe fetch → artifact                                             |
| `core.browser_fetch`, `core.browser_crawl`              | Sandboxed Chromium behind the egress proxy; bounded, host-scoped crawl |
| `core.parse_csv`, `core.parse_json`                     | Parse artifacts into record sets                                       |
| `core.map_fields`, `core.filter`, `core.dedupe_records` | Declarative record transforms (no code)                                |
| `core.if`, `core.switch`                                | Branching via `output.branch`                                          |
| `core.for_each`                                         | Bounded fan-out (engine-implemented)                                   |
| `core.execute_subworkflow`                              | Reuse a workflow as one step                                           |
| `core.store_artifact`, `core.load_artifact`             | Artifact I/O (reprocessing without refetch)                            |
| `core.ai_extract`                                       | Registered, versioned structured-extraction task via the AI gateway    |

### Browser security model (audit B-4)

Chromium is untrusted-content execution, so it gets two independent layers:

1. **Egress proxy.** Every browser request (HTTP, and HTTPS via `CONNECT`) goes through an
   in-process `SafeEgressProxy` (`packages/net`). It resolves the hostname **once**, validates
   every resolved address with the same private/loopback/link-local/metadata policy as
   `core.http_request`, and connects to the validated IP — so DNS rebinding between check and
   connect is impossible. Blocked requests get a 403 with `x-aptamind-egress-blocked`; a blocked
   main document fails the node with `UnsafeUrlError`. Chromium is launched with
   `--proxy-server`, `--proxy-bypass-list=<-loopback>` (no implicit loopback bypass), and
   WebRTC non-proxied UDP and QUIC disabled, so no request path skips the proxy.
2. **OS sandbox.** Chromium runs with its sandbox on (`chromiumSandbox: true`, and the default
   `--no-sandbox` flag is removed). Chromium's sandbox refuses to run as root, so a root
   container launches it through `scripts/chromium-unprivileged.sh` (`setpriv` to
   `CHROMIUM_RUN_AS`), configured via `BROWSER_EXECUTABLE_PATH`. If Chromium cannot start
   sandboxed the capability fails with `BrowserUnavailableError`; there is no unsandboxed
   fallback.

`packages/testing/src/runtime/browser.int.test.ts` (21 tests) covers localhost, loopback
(IPv4, IPv6, IPv4-mapped IPv6), RFC 1918, link-local, cloud metadata and `file:` URLs;
redirects to private addresses, metadata and privately-resolving names; public names
resolving to a private address; private sub-resources, TLS tunnels and WebSockets from an
allowed page; DNS rebinding; that no private target was ever connected to; that the live
renderer processes run under a seccomp-bpf filter and never with `--no-sandbox` (checked from
`/proc` for any user, so it runs in CI); and, as root, that Chromium without the privilege drop
is refused. These tests never skip: missing Chromium is a
failure, and CI installs it.

The worker's `/api/capabilities` endpoint lists every registered capability with its JSON Schemas.

## Future compatibility

The same contract supports the future flows named in the context doc: CV upload → parse →
extract assertions → `ctx.suspend` for confirmation; code-provider analysis as a long-running
capability on its own queue; job+profile evidence mapping as a domain capability; application
follow-ups as scheduled/waiting workflows. None of these require engine changes.
