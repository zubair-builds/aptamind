# ADR-0008: No authentication in v0.1, with a request-context seam

- Status: Accepted
- Date: 2026-09-27

## Context

Authentication is explicitly out of scope, but must be addable without rewriting domain modules.

## Decision

Every mutating domain method takes an `Actor`. The API derives it in one function (`resolveActor`) which returns `unauthenticated-internal-operator`; workers use `system`/`workflow` actors. Audit events record the actor. Config refuses `API_HOST=0.0.0.0` in production; docs state the admin/API are internal-only.

## Consequences

Adding auth = implement `resolveActor` (+ authorization checks at the API edge). Until then the deployment must be private.
