# FE-5 — additive `user` actor kind

Status: **Approved by owner 2026-10-31 (plan decision D7). Implemented in milestone M-U1** on branch
`a2/m-u1-fe5-user-actor` (plan `../plans/users-ui-mcp.md`, ADR-0022). `actorSchema` is a
`z.discriminatedUnion('kind', …)`; existing variants unchanged; tests in
`packages/contracts/src/request-context.test.ts`.

## Problem

`actorSchema` in `packages/contracts/src/request-context.ts` only knows `system`,
`internal-operator` and `workflow`. Once people sign in (D1, D2, D10) and use MCP tokens (D4),
every mutation must record which person made it and in which workspace (D5). Today they would all
collapse into the shared `internal-operator` actor.

## Why a local fix is insufficient

`Actor` is a frozen contract consumed by every domain, the audit log and the runtime. A
stream-local actor type would not pass through domain APIs or validate in audit events.

## Affected packages

- `packages/contracts` (frozen): `actorSchema` / `Actor`.
- Consumers (admin API, MCP, audit writers) adopt it in later milestones; no domain API changes.

## Change

Add a `user` kind to `actorSchema`, carrying `userId` and `workspaceId` (plus optional role/token
claims, e.g. `roles`, `tokenId`, for MCP calls). Preferably a discriminated union so `userId` and
`workspaceId` are required for `user` and absent for other kinds.

## Compatibility

Additive only. Existing kinds (`system`, `internal-operator`, `workflow`), `SYSTEM_ACTOR` and
`UNAUTHENTICATED_INTERNAL_OPERATOR` are unchanged. Old audit events and stored actors still parse.
Exhaustive `switch`es over `actor.kind` must gain a `user` branch.

## Migration

None. No records are rewritten or backfilled.

## Tests

- Old actors and historical audit events parse unchanged.
- A `user` actor with `userId` and `workspaceId` parses; one missing either is rejected.
- Full Foundation regression and architecture gate pass.

## Alternatives

- **Reuse `internal-operator` with the user id in `id`.** Rejected: loses workspace and makes
  user vs operator ambiguous in audit.
- **Separate per-domain actor types.** Rejected: breaks the single shared seam.
