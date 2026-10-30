# ADR-0001: Modular monolith with asynchronous workers

- Status: Accepted
- Date: 2026-09-27

## Context

The programme must prove a reusable execution substrate and a Market domain without speculative infrastructure (no microservices, Kubernetes, Kafka, Temporal).

## Decision

One pnpm/TypeScript monorepo; two deployables (`apps/admin`, `apps/worker`) composed from packages by a single composition root (`packages/platform`). The Next.js admin owns the internal HTTP API through server route handlers; workers execute asynchronous work. Package boundaries are explicit (`contracts`, `db`, `queue`, `storage`, `net`, `observability`, `ai`, `provenance`, `taxonomy`, `workflow-sdk`, `workflows`, `workflow-nodes`, `market`) and enforced with ESLint `no-restricted-imports`.

## Consequences

Simple to run and operate; workers scale horizontally and per capability class via `WORKER_QUEUES`. Splitting services later is possible along package boundaries but not needed now.
