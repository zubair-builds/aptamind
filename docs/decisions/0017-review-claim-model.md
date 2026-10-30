# ADR-0017: Review decisions are applied through a durable, generation-fenced operation

- Status: Accepted (amended twice: durable operation + outbox; then effect-level generation
  fencing, validation before the claim and release of failed decisions)
- Date: 2026-09-27 (market foundation hardening, audit finding B-3)

## Context

Resolving a review item mutates domain state (merges, new companies, overrides) and then
closes the item. The audit showed that two operators, or one client retrying, could both pass
the "item is open" check and apply two different decisions — for example one merge and one
"keep separate" — leaving contradictory state. Authentication and user management are out of
scope for v0.1, so locking by user session is not an option.

## Decision

A review resolution is a durable operation (`market_review_operations`, one record per review
item; resolved items are never reopened):
`(validated) → claimed → applied → finalized → completed`, plus `failed` for a released decision.

- **Validate before the claim.** Every deterministic check — the decision's shape (action allowed
  and supported, target present and a candidate, field correctable, value valid) and every domain
  precondition checkable now (target exists and is active, merge legal, `create_new` would not
  clash with another company's identity, source retryable) — runs before anything is persisted.
  An invalid decision is rejected (`validation_failed`) and never becomes the operation.
- **One decision.** The first valid claim stores the decision, its author and the logical
  operation id (the API maps `Idempotency-Key` to it). Nothing else is applied while it lives.
- **Effects are generation-fenced, not checked afterwards.** All canonical writes of a decision
  and its result commit in one MongoDB transaction whose first write is a compare-and-set on the
  operation's generation (and `state = claimed`). A resolver that lost its generation commits
  nothing. The one non-Mongo effect, `retry`'s source run, is never launched by an owner. The
  fenced transaction commits a durable **retry intent**, and a dispatcher launches the run from
  it (outbox) with the intent's idempotency key. An intent exists only if the retry decision won,
  so a superseded retry cannot launch, and a re-dispatch returns the same run. Derived
  recomputation (reconciliation) runs after the fence and is revision-fenced: a precomputed
  company or job state commits only if the entity's revision is unchanged, otherwise it is
  recomputed from a fresh read. Closing is a transaction fenced on the generation too.
- **Leases are renewed.** A working owner renews its claim every minute; only an owner silent for
  10 minutes is recoverable. Recovery is a compare-and-set on the generation read and the expired
  lease; it advances the generation and completes the stored decision.
- **Deterministic failure releases; transient failure retains.** A stored decision that fails
  deterministically after its claim committed nothing: the operation becomes `failed`, the item
  stays open with `lastFailure`, and a corrected decision claims it as the next generation. A
  transient failure keeps the operation claimed for the owner's resume or a recovery.
- **Outbox.** Closing the item and finalizing the operation commit in one transaction. The
  retry-intent dispatch, the audit event and the resume of waiting workflows are outbox steps
  recorded as delivered, finished by
  the owner's retry, any later resolver, or the recovery relay run by the hourly freshness sweep.
  The relay recovers each operation in isolation (a failure is recorded, counted and skipped),
  reads only live operations, and keeps `recoveredFrom` bounded.

The first version of this ADR used only an atomic claim on the review item. An independent
re-audit showed that a `retry` decision recovered after a crash launched the source twice, that
a stalled original owner could still act after recovery, and that an item could be resolved
with no path left to deliver its audit event or resume its workflow.

**Correction.** The second version claimed the generation fence was complete. It was not: the
fence was checked when the owner _advanced_ the operation, i.e. after its domain writes. The
final independent audit (B3-A) reproduced a stalled owner that, after being recovered and after
a newer review had set a newer value, resumed and wrote its old canonical value before getting
its conflict. It also (B3-B) persisted decisions that could never apply (target not a candidate,
missing target, unsupported field, `create_new` identity clash); the item then stayed claimed, a
corrected decision got 409 and recovery retried the same bad decision forever, and one failing
operation aborted the whole recovery sweep. The current design above fixes these; every case is
a permanent test in `packages/market/src/review-resolution.int.test.ts`.

**Second correction.** The third version still kept two check-then-act boundaries. (B3-R1) The
retry launch was guarded by an ownership check made immediately before a non-transactional
`runNow`: an owner frozen between the check and the launch, whose decision was meanwhile
released and re-decided as `dismiss`, still started the source run. The per-item run key
prevented a second run but not an obsolete one. (B3-R2) Company reconciliation computed a
snapshot and later wrote it (whole document, last writer wins), so a stale owner overwrote a
newer review's canonical website before getting its conflict. The retry is now a durable intent
committed under the fence and dispatched from the outbox. Company reconciliation now writes only
derived fields with a revision compare-and-set and recomputes on conflict. The independent
reproductions of both are permanent tests.

## Consequences

- One review decision is applied, with one logical set of effects, whatever the concurrency or crashes.
- An operator racing another sees a clear conflict instead of silently overwriting.
- A crashed resolution delays the item by at most the stale window and never changes the
  decision that was taken; a slow one is not interrupted.
- A resolver that lost its claim cannot change canonical state, the item or the operation.
- A decision that cannot be applied never blocks the item: it is rejected up front, or released
  with its reason if it became inapplicable after the claim.
- Review effects that write several collections pay for a multi-document transaction; services
  involved (`CompanyService.merge`/`markDistinct`/`createFromCandidate`,
  `ObservationService.recordCompanyObservation`/`setCompanyResolution`, `AuditLog.record`) accept
  the caller's session.
