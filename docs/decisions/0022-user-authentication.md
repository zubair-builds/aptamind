# ADR-0022: User authentication with Better Auth and Google sign-in

- Status: Accepted
- Date: 2026-10-31
- Supersedes in part: [ADR-0008](0008-no-auth-seam.md)
- Plan: [users-ui-mcp](../programme/plans/users-ui-mcp.md) (owner decisions D1, D2, D5, D9, D10)

## Context

ADR-0008 kept the admin unauthenticated behind one shared basic-auth password, with a
request-context seam so authentication could be added later without rewriting domain modules.
The owner has approved user accounts (D1), Better Auth on MongoDB (D2), single-workspace tenancy
with a stored `workspaceId` (D5), role- and permission-based access (D9) and Google-only sign-in
with admin pre-approval (D10). Foundation Exception FE-5 adds the matching `user` actor kind.

## Decision

- **Library.** Better Auth with its MongoDB adapter, configured with the **Google provider only**.
  No passwords, magic links or invite emails in v1. Dependencies are pinned exactly.
- **Collections.** Better Auth owns its own collections (user, session, account, verification),
  named separately from ours; we never extend its model. Aptamind keeps a separate `users`
  collection in `packages/identity`, linked one-to-one by a unique `authUserId`, plus
  `workspaces`, `memberships` and (later, M-U6) `api_tokens`.
- **Approval.** An admin pre-approves emails (`pre_approved`). A Google sign-in with a
  pre-approved email becomes `active`; an unknown email becomes `pending_approval` and has no
  access until an admin approves it. `suspended` users are refused and their sessions revoked.
- **Roles and permissions.** Roles are a string enum `admin | user` (extensible). Access is checked
  by permission, never by role name: effective permissions = role defaults + per-user grants −
  revokes; admin has all. Checks are enforced on the server for pages, API and MCP. The last
  admin cannot be demoted or suspended.
- **Bootstrap.** `ADMIN_EMAIL` makes that Google account the first admin on sign-in, **only when
  no admin exists**. Concurrent first sign-ins produce one admin.
- **Tenancy.** One shared workspace in v1; `workspaceId` is stored on users, memberships, tokens
  and user-owned records from day one.
- **Sessions.** Opaque, httpOnly, `SameSite=Lax`, `Secure` in production cookies backed by Better
  Auth's Mongo session collection, so sessions are revocable.
- **Actor.** Requests from a session resolve to the FE-5 `user` actor (`userId`, `workspaceId`,
  optional `roles`); audit records it. Existing actor kinds are unchanged.
- **Rollout.** Better Auth is mounted at `/api/auth/*` behind an `AUTH_ENABLED` flag. With the flag
  off, behaviour is unchanged. The shared basic-auth password (`ADMIN_PASSWORD`) stays as a
  break-glass fallback until M-U4 removes it.
- **Configuration (names only).** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ADMIN_EMAIL`, `AUTH_ENABLED`. Until the owner creates
  the Google OAuth client, previews and tests use a test client or mocked Google profiles.

## Consequences

- ADR-0008's "no authentication" decision is superseded for the approved users/auth work; its
  request-context seam stays and is where the session-derived actor plugs in (M-U3).
- A young, fast-moving library: upgrades are pinned and reviewed.
- Auth changes are high-impact: M-U2 and M-U3 need two independent reviews; sign-in and
  user-admin endpoints are rate-limited.
- Delivery: M-U1 (FE-5 actor kind), M-U2 (`packages/identity` and Better Auth behind the flag),
  M-U3 (`resolveActor` and `requirePermission`), M-U4 (login UI, user admin, basic auth removed).
