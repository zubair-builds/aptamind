# ADR-0002: MongoDB is the source of truth; BullMQ is transport only

- Status: Accepted
- Date: 2026-09-27

## Context

Workflow state must survive worker crashes, Redis restarts and API restarts (Law E).

## Decision

All run/node/chunk/schedule state lives in MongoDB (replica set, majority writes, transactions where two documents must change together). BullMQ jobs carry only pointers (`nodeRunId`, `chunkId`) with deterministic job ids; BullMQ retries are disabled (`attempts: 1`) — the engine owns retries. Workers claim work with atomic compare-and-set + leases. A sweeper re-dispatches from Mongo when transport jobs are lost. Wake-ups are sent only after the Mongo write they announce and are best-effort: a failed dispatch (Redis down) is logged and counted, never turned into a failure of the recorded state change (ADR-0013). BullMQ is pinned to 5.x (6.x introduced a pluggable-backend API not needed here).

## Consequences

Duplicate or lost deliveries are harmless; Redis can be flushed or unavailable without losing runs or making completed state unknowable, and new runs are accepted durably while it is down (tested in the F1 gate suite). Extra Mongo writes per node are the cost.
