# ADR-0021: Next.js API boundary with separate workers

- Status: Accepted
- Date: 2026-10-30

## Context

The admin UI and internal API were separate deployables. The admin made server-side requests to a
Fastify API, while workers execute durable workflow work separately. This added an avoidable
deployment and networking boundary for the UI-facing API.

## Decision

Next.js becomes the UI and HTTP API deployable. API requests use same-origin `/api/*` routes, and
the worker remains a separate deployable. During migration, the Next.js catch-all route forwards
requests are handled by the embedded Fastify composition through `app.inject()`. This preserves
route semantics, raw uploads, request IDs, and the existing integration-test harness without
requiring a separate API listener.

The shared `packages/platform` composition root remains the source of domain wiring. It may be
used by Next.js server code after each route is migrated, but domain packages must not import
Next.js. Workers continue to own workflow execution, scheduling, and recovery.

## Consequences

- One UI/API deployment and one same-origin network path for admin traffic.
- API route modules live under `apps/admin/lib/api-server` and are not imported by the browser.
- Large uploads pass through Next.js and retain the existing 200 MB server-action/API limits.
- API route migration must preserve actor context, request IDs, error envelopes, observability,
  idempotency, and private-domain access guards.
