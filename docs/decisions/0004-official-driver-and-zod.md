# ADR-0004: Official MongoDB driver + Zod; no ODM

- Status: Accepted
- Date: 2026-09-27

## Context

Mongo's flexibility must not become schema anarchy, and database behaviour must stay visible.

## Decision

Use the official driver directly with `defineCollection` specs (Zod schema, schema version, indexes with rationale, optional `$jsonSchema` validator). Documents are validated at write boundaries (`validateDocument`) and capability I/O is validated by the engine. `ignoreUndefined` is on so optional fields are absent rather than `null`. Migrations are idempotent, lock-protected and recorded in `_migrations`; `docs/architecture/data-model.md` is generated from the specs.

## Consequences

Explicit queries and indexes; a little more boilerplate than an ODM.
