# ADR-0003: Static DAG runtime with bounded fan-out and no code node

- Status: Accepted
- Date: 2026-09-27

## Context

The runtime must support low-level primitives and sophisticated capabilities with one contract, be observable, and remain small. Temporal was explicitly excluded unless BullMQ could not meet a requirement.

## Decision

Static DAG of typed capabilities (`type@version` with Zod config/input/output), conditional edges via `output.branch`, JSON input templates with `$ref` paths (no expression language), engine-implemented `core.for_each` (chunked, slot-bounded, per-item idempotency), inline durable subworkflows, `ctx.suspend`/resume for human waits, immutable content-hashed versions, Mongo-driven schedules. No arbitrary/unsandboxed code node; source-specific logic is a registered code capability (Node's `vm` is not a security boundary).

## Consequences

All PRD FR-1..FR-6 requirements are met without Temporal. Loops/dynamic graphs are out of scope; long-running child workflows run inline in a worker slot (acceptable for v0.1).
