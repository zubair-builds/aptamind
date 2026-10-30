# ADR-0010: Conservative job lifecycle and closure policy

- Status: Accepted (amended 2026-09-29, PR #11)
- Date: 2026-09-27

## Context

Jobs must not be mass-closed because a fetch failed (FR-15, FR-19).

## Decision

Only complete listings from authoritative sources can signal absence, and only when the fetch succeeded and item processing was healthy; one absence → `POSSIBLY_STALE` + verification, two consecutive → `CLOSED`. A listing (identified by its snapshot fetch time) is applied at most once, so reprocessing cannot count as a new absence. Verification `not_found` closes only when repeated or combined with listing absence; `inconclusive` changes nothing; time-based staleness never closes. Empty listings after non-empty ones are treated as anomalies.

## Consequences

Closure lags by one refresh cycle — preferable to false closures.

## Amendment (2026-09-29, PR #11)

The supervisor's lifecycle rulings L1, L2, U1 and E1 amend this decision. They are recorded in
`docs/programme/DECISION_LOG.md` (landing with supervisor PR #19); that log is authoritative,
and this section only points to it. In short:

- **L1** replaces "two consecutive → `CLOSED`": absence alone never closes a job. An
  absence-driven close also needs a `not_found` verification since the first absence. A board-derived
  (Ashby) `not_found` counts only on a trustworthy board.
- **L2** refines "empty listings are anomalies": a board of ≥ 10 that collapses is held with a
  review, and a smaller board that empties is held for one run.
- **U1**: entries on the board that the adapter did not map are seen, not verified.
- **E1**: verification uses the host the source is fetched from.
- **a9af734** (fourth round): only authoritative evidence resets or blocks an absence run, an
  absence after such evidence restarts the run, and a verification result is re-gated when it
  is applied.

Implementation: `jobs/lifecycle.ts` (`job-lifecycle/3`) and `jobs/listing-policy.ts`, described
in `docs/architecture/market-domain.md`.
