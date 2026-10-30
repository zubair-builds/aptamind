# ADR-0005: Observation-first ingestion with fact-level provenance

- Status: Accepted
- Date: 2026-09-27

## Context

External data is observation, not truth (Law A); operators must see why a value is believed (FR-23).

## Decision

Sources → content-addressed snapshots → append-only observations (deterministic ids from source/record/payload) → resolution → deterministic reconciliation into `Fact<T>` fields carrying evidence, confidence, conflicts and policy version. Field authority is configurable per field. Operator corrections are recorded as observations from a `system:operator` source (companies) or overrides with `operator` authority (jobs).

## Consequences

Canonical documents can always be recomputed from observations; conflicting evidence is never deleted. Reconciliation recomputes a company from all its observations, which is O(observations) per company — fine at current scale, revisit with incremental reconciliation if companies accumulate thousands of observations.
