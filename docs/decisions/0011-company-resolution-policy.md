# ADR-0011: Deterministic company resolution with review on ambiguity

- Status: Accepted
- Date: 2026-09-27

## Context

Duplicate companies and wrong merges are both costly; merges must be auditable (FR-9).

## Decision

Evidence order: external id → official domain (with an unrelated-name safety net) → strict legal name/alias → legal-form-insensitive brand match (single candidate only) → fuzzy (review only). A unique `identityKeys` index prevents concurrent duplicate creation. Ambiguity creates deduplicated review items; merges/creations/rejections are applied by the review service and audited with enough detail to reverse. Private public-suffix domains are honoured (e.g. `acme.herokuapp.com`).

## Consequences

High precision; some legitimate matches (e.g. same legal name without a legal form in two towns) need an operator decision.
