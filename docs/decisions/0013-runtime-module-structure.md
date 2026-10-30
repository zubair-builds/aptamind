# ADR-0013: Workflow runtime structured as an orchestrator over explicit components

- Status: Accepted
- Date: 2026-09-27 (F1 architecture and reliability audit)

## Context

After F1, `packages/workflows/src/engine.ts` (≈1,660 lines) held the DAG evaluation, run and
node persistence, claiming and leases, retry decisions, timeouts, heartbeats, cancellation,
fan-out, subworkflows, output offloading and dispatch. Everything worked and was tested, but
the policies could not be unit-tested in isolation, capabilities received the whole engine
through their context, a transport failure after a committed state change surfaced as an
error to the caller, and the runtime carried a Market label name (`sourceId`) in an index,
a read-model filter and its log correlation.

## Decision

`WorkflowEngine` is an orchestrator. It composes components with explicit interfaces and keeps
only run advancement (graph evaluation → persistence → wake-ups) and operator actions:

| Concern                           | Module                                                | Kind         |
| --------------------------------- | ----------------------------------------------------- | ------------ |
| Definitions / immutable versions  | `catalog.ts` (`WorkflowCatalog`)                      | persistence  |
| Trigger → run document            | `triggers.ts` (`buildRunDocument`, `StartRunRequest`) | pure         |
| Graph / dependency evaluation     | `graph.ts`                                            | pure         |
| State-transition policy           | `state-machine.ts`                                    | pure         |
| Retry policy (budget, backoff)    | `retry-policy.ts`                                     | pure         |
| WorkflowRun state                 | `stores/run-store.ts`                                 | persistence  |
| NodeRun state, leases, attempts   | `stores/node-run-store.ts`                            | persistence  |
| Fan-out chunks, slots, aggregates | `stores/chunk-store.ts`                               | persistence  |
| Capability lookup + one attempt   | `registry.ts`, `node-executor.ts`                     | coordination |
| Timeout / heartbeat / abort       | `execution-guard.ts`                                  | mechanism    |
| Cancellation                      | `cancellation.ts`                                     | coordination |
| Bounded fan-out                   | `fanout.ts`                                           | coordination |
| Subworkflow invocation            | `subworkflows.ts`                                     | coordination |
| Outputs and artifact references   | `outputs.ts`                                          | persistence  |
| Transport wake-ups                | `transport.ts` (`WakeUps`) over `dispatcher.ts`       | adapter      |
| Runtime errors                    | `errors.ts`                                           | —            |
| Callback port                     | `ports.ts` (`RunDriver`, `SubworkflowInvoker`)        | interface    |

Rules that come with the structure:

- Components never hold the engine: they receive stores and the narrow `RunDriver` port.
  Capabilities receive a `CapabilityEnvironment` (services, artifacts, subworkflows) only.
- Every NodeRun write that ends an attempt is fenced by the lease (`AttemptFence`); a worker
  that lost its lease cannot overwrite the new owner's outcome.
- Wake-ups are best-effort (`WakeUps`): Mongo is committed first; a failed dispatch is logged
  and counted (`workflow_dispatch_failures_total`) and recovered by the sweeper — never
  propagated as a failure of an already-recorded state change (ADR-0002).
- A failure to persist a finished attempt (`AcknowledgementError`) is retryable regardless of
  the capability's default: execution is at-least-once and effects are exactly-once through
  idempotency keys.
- The runtime names no domain concept: log/artifact correlation uses any `*Id` run label,
  read models filter by arbitrary labels, and domain label indexes are created by the
  composition root (`packages/platform` migration `2026-09-27-003`).
- `scripts/check-architecture.ts` (in `pnpm check` and CI) enforces package layering, declared
  imports, that only `dispatcher.ts`/`worker-host.ts`/`runtime.ts` touch the queue, and that
  the pure modules import no I/O.

## Consequences

The public `WorkflowEngine` API is unchanged (sweeper, scheduler, API and tests use it as
before). Graph, retry and guard behaviour have unit tests; reliability properties have a
dedicated gate suite (`packages/testing/src/runtime/runtime-gate.int.test.ts`). A new domain
(Professional, Opportunity, repository analysis, agent-backed capabilities) plugs in through
capabilities, services and ports without touching these modules.
