# ADR-0015: At-least-once execution with a typed capability idempotency contract

- Status: Accepted
- Date: 2026-09-27 (market foundation hardening, audit findings H-3, H-1, B-1, B-2)

## Context

The runtime executes a node attempt more than once in normal operation: a lease takeover
after a crash, a retry after a failure, or a failed acknowledgement (the capability succeeded
but its output could not be recorded). The audit found the previous documentation claimed
"effects are exactly-once by idempotency key" while the contract was a free-form flag
(`idempotency: 'none' | 'key' | …`) that nothing enforced, and several Market capabilities
(listing absence, verification, AI proposals) were not safe to run twice.

Exactly-once execution would need a distributed transaction between the capability's side
effects and the runtime's bookkeeping. That is not available across HTTP calls, S3 and
MongoDB, and adopting a different workflow runtime is out of scope.

## Decision

1. The runtime guarantees **at-least-once** execution and says so. It does not claim
   exactly-once effects.
2. Every capability declares one of four strategies as a discriminated union, enforced by the
   type system and again at registration (`executionContractViolation`):
   `pure` (no durable side effects), `key` (effects keyed on `ctx.idempotencyKey`), `natural`
   (idempotent by construction: deterministic ids, unique keys, replay markers), or `no_retry`
   (never re-executed automatically; an interrupted attempt fails with
   `UnsafeReexecutionError`). `key` and `natural` require a written `idempotencyProof`.
3. The capability matrix is generated from the definitions (`pnpm docs:capabilities`) so the
   documentation cannot drift from the code.
4. All writes on behalf of an attempt are lease-fenced on `state`, `leaseOwner` **and** the
   attempt generation, through a typed lease token (`AttemptFence`, `ChunkLease`) — including
   attempt start, heartbeats, completion, retries, suspension, fan-out entry and every chunk
   write. A worker id alone is never a fence: the same worker id can hold a newer attempt.
5. Acknowledgement failures get a small separate retry budget (`ackRetries`), because
   replaying them is safe exactly when the contract holds.
6. Domain state changes that are not naturally idempotent use durable replay markers written
   atomically with the effect: listing marks per snapshot (same CAS write), the verification
   operation's `lifecycleApplied` flag (same transaction as the job update), the durable review
   operation (ADR-0017), source-run outcome markers for health counters, and an AI operation
   ledger. A replay fence must hold for the operation's whole replayable lifetime: fences are
   records that are retained, never bounded lists that rotate (a bounded list of applied
   verification ids was shown to fail after 50 newer operations).

## Consequences

- A new capability cannot be registered without choosing and justifying a strategy.
- Correctness under re-execution is tested by fault injection (`ack-replay.int.test.ts`,
  `replay-safety.int.test.ts`, the runtime crash test) rather than asserted in prose.
- `no_retry` capabilities cannot be fanned out or operator-retried; if one is ever needed, an
  operator decides what to do after an interruption.
- Replay-fence records are retained indefinitely while the replay horizon is unbounded; archival requires bounding that horizon first.
