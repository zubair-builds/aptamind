# ADR-0020: Professional Intelligence as a domain package with an assertion model and confirmed-truth precedence

- Status: Accepted (supervisor review, 2026-09-29)
- Date: 2026-09-29
- Context documents: [professional-context-and-requirements.md](../architecture/professional-context-and-requirements.md),
  [professional-domain.md](../architecture/professional-domain.md)

## Context

Aptamind needs a second intelligence domain that answers what is true about a professional, what
evidence supports it, what the professional confirmed and which career directions they target.
The Foundation (frozen at `foundation-v0.1`) already provides the substrate: a generic workflow
runtime, content-addressed artifacts, a provider-neutral AI gateway, provenance primitives and an
`Actor` seam. The owner decided (2026-09-29) that user-confirmed facts outrank model inference,
that contradictions become conflicts rather than silent replacements, that history is never
destroyed, and that Professional Fit is not Application Viability.

Market's model does not transfer directly. Market reconciles **sources about an external entity**
by source authority (`official_registry > official_ats > … > inferred`), and operators are the
final authority. For a professional, the **subject** is the authority on themselves, sources are
mostly authored by the subject, change over time is normal (a new job, a move) and must be told
apart from contradiction, and absence of a claim in a newer document is not evidence against it.

## Decision

1. **New domain package** `@aptamind/professional` beside `@aptamind/market`, in the `DOMAIN` set
   of `scripts/check-architecture.ts` with the same allow-list as Market. Domains never import each
   other; shared vocabulary comes from `@aptamind/taxonomy` and `@aptamind/provenance`. Collections
   are `professional_*`, capabilities `professional.*`, routes `/api/professional/*`. The
   composition root wires it; no frozen package changes are required for v0.1.
2. **Observation → assertion → item model.** Append-only observations (one extracted statement
   with verbatim evidence, mode `stated | extracted | inferred`, extractor metadata) resolve to
   **items** (one role, one skill, the current location). An **assertion** is one normalized value
   for one item, shared by every observation that supports it. Assertions have a lifecycle
   `PROPOSED | CONFIRMED | REJECTED | SUPERSEDED | CONFLICTED | WITHDRAWN` enforced by a pure,
   table-tested state machine with two actor classes: automation and subject.
3. **Confirmed-truth precedence.** Basis order `confirmed > stated > extracted > inferred`.
   Transitions into or out of `CONFIRMED`/`REJECTED` require a subject confirmation operation.
   Evidence contradicting a confirmed value marks the challenger `CONFLICTED`, records the conflict
   on the item and opens a `reconfirm` request; the canonical value is unchanged. Unconfirmed
   values change only by a named policy rule (e.g. a newer `current_state` value), always with an
   event and a new profile version.
4. **Compatibility, not equality.** Conflicts are decided by versioned per-type compatibility rules
   (date precision, `present` with its `asOf`, title and organization normalization); field
   classes `current_state | historical | set_member` decide whether chronology may replace an
   unconfirmed value.
5. **Decisions are single-transaction operations fenced by the item revision the decider saw**
   (`expectedItemRev`), with deterministic operation ids from `Idempotency-Key`. Because a
   decision has no external effect, the ADR-0017 claim/generation machinery is unnecessary; the
   post-commit steps (profile version, workflow resume) are idempotent outbox steps.
6. **History by construction.** Nothing is deleted by domain operations: observations, assertions,
   operations, events, immutable profile versions and career-target versions. Canonical state is
   addressable as `(subjectId, profileVersion)` and `(targetId, version)`.
7. **Sectioned profile.** Every claim type belongs to one section — `identity`, `capability`,
   `preferences`, `eligibility` — and read models are exported per section, so a future fit
   computation cannot read eligibility (visa, location, relocation).
8. **v0.1 attestation** is `operator_relayed`: an internal operator records the subject's
   confirmation; the mode is stored so direct subject confirmation can be distinguished after auth.

## Alternatives considered

- **Reuse `selectFact` with authority tiers.** Rejected for v0.1: `AUTHORITY_TIERS` has no subject
  tiers, `selectFact` lets a newer same-tier value win (wrong for historical facts), and it has no
  notion of confirmed state. Professional keeps `Confidence`/`EvidenceReference` shapes and its own
  precedence; adding subject tiers to `@aptamind/provenance` is Foundation Exception candidate FE-P4.
- **Facts directly on a profile document (no assertions).** Rejected: confirmation, rejection
  and supersession must attach to a specific value with its own history; a field-level fact would
  lose which value the subject confirmed when evidence changes.
- **ADR-0017 review-operation pattern for confirmations.** Rejected as unnecessary complexity for
  effects that fit in one transaction; to be adopted if decisions gain external effects.
- **Per-field last-writer-wins with manual overrides (Market jobs' operator overrides).**
  Rejected: violates PL-2 (silent replacement) and PL-5 (history).

## Consequences

- Professional plugs into the frozen runtime without engine changes; `pnpm check:arch` enforces
  isolation from Market.
- Every canonical change is explainable from stored data: observation → assertion → item →
  profile version, with actor and reason.
- Confirmation requires an explicit decision against the current item revision; operators
  relaying stale views get a 409 and must reload.
- Per-subject resolution is serialized (subject revision CAS); acceptable because per-subject
  volume is small, and it removes duplicate-item races for unkeyed items.
- Erasure cannot be implemented until `ArtifactStore` supports deletion (FE-P2); until then only
  synthetic and owner-consented data may be processed.
