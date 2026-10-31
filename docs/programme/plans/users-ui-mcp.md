# Plan: user accounts, UI revamp and MCP server

- Status: **PROPOSED — partly approved.** Owner approved RBAC (D9) and Google-only login (D10) on 2026-10-31; everything else in §5 is still pending. Nothing is built until the remaining decisions are answered.
- Date: 2026-10-31 · Author: Aptamind bot for Zubair Haider
- Scope: three owner asks — (1) user accounts managed from Admin, (2) UI revamp, (3) an MCP server.
- Order: **Users → UI → MCP.** MCP needs per-user tokens, and the UI revamp needs to know which app(s) and roles exist.

## 0. Where we are (grounding)

| Area        | Current state                                                                                                                                                               | Files                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Auth        | One shared basic-auth password (`ADMIN_PASSWORD`) over every route except `/health`; if unset, the admin is open.                                                           | `apps/admin/middleware.ts`, `apps/admin/lib/basic-auth.ts` (PR 4)                                                                 |
| Actor seam  | Every request becomes `unauthenticated-internal-operator`; domain methods already take an `Actor` and audit records it.                                                     | `apps/admin/lib/api-server/request-context.ts` (`resolveActor`), `packages/contracts/src/request-context.ts`, ADR-0008            |
| Actor kinds | `system \| internal-operator \| workflow` — no `user` kind. `packages/contracts` is **Foundation (frozen)**.                                                                | `packages/contracts/src/request-context.ts`, CLAUDE.md                                                                            |
| API         | Next.js `/api/*` forwards to an embedded Fastify app via `app.inject()`; routes in `lib/api-server/routes/*`.                                                               | ADR-0021, `apps/admin/lib/api-server/app.ts`                                                                                      |
| Data        | MongoDB collections defined with Zod-derived validators, idempotent index sync.                                                                                             | `packages/db/src/collections.ts`                                                                                                  |
| UI          | Attio-inspired design system v1: CSS tokens + CSS Modules, no Tailwind, no UI kit, `components/ui` fenced by ESLint; no `packages/ui` until a second React consumer exists. | `docs/design/admin-design-system.md`, `apps/admin/styles/tokens.css`, `apps/admin/components/{ui,shell}`, DECISION_LOG 2026-09-29 |
| Scope rules | CLAUDE.md "Prohibited scope" lists **authentication programme** and **candidate-agent autonomy**; programme rule says "no MCP agents".                                      | `CLAUDE.md`, `docs/programme/DECISION_LOG.md`                                                                                     |

So all three asks need explicit owner decisions to lift current rules.

## 1. User accounts + admin management

### Goals

- Real per-person login replaces the shared password; every audit event names a real user.
- Admin can add/pre-approve, approve, suspend and change roles of users, and controls what users can see; early-access requests from www.aptamind.app can become pending users.
- Ready for per-user data (Professional) and per-user API tokens (MCP).

### Auth approach — options

| Option                                             | Pros                                                                                                                                                    | Cons                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **A. Better Auth + MongoDB adapter** (recommended) | TS-first, Mongo adapter, email/password, magic link, Google OAuth, organizations/roles and API-key plugins built in; sessions in our own DB; no vendor. | Young library, fast-moving API; we must pin and review upgrades.                                                       |
| B. Auth.js (NextAuth v5)                           | Mature, many providers.                                                                                                                                 | Weak credentials/roles story, no orgs or API keys; Mongo adapter + JWT/session split is awkward with Fastify `inject`. |
| C. Own sessions in Mongo                           | Full control, tiny surface.                                                                                                                             | We own password hashing, reset, OAuth, rate limiting, CSRF — security risk and effort.                                 |
| D. Hosted (Clerk/Auth0)                            | Fastest, polished UI.                                                                                                                                   | Paid third-party commitment, personal data leaves our stack, vendor lock-in.                                           |

**Decision: A** (D2 APPROVED by owner 2026-10-31), configured with the **Google provider only** — owner-approved D10: Google sign-in only in v1, no magic links, no passwords. Env vars the owner sets (names only): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ADMIN_EMAIL`. Sessions are opaque, httpOnly, `SameSite=Lax` cookies backed by a Mongo `sessions` collection (revocable).

### Data model (new, in a new `packages/identity` composition-level package, not Foundation)

- `users` — `_id`, email (unique, lower-cased), name, status `pre_approved|pending_approval|active|suspended`, `role` string enum `admin|user` (more values such as `owner`/`operator` can be added later without migration), `permissionOverrides` `{grant[], revoke[]}`, createdAt, lastLoginAt.
- `sessions`, `accounts` (OAuth links), `verifications` — owned by Better Auth.
- `workspaces` (incl. `userDefaultPermissions[]`) + `memberships` (`userId`, `workspaceId`, `role` `admin|user`) — **single default workspace in v1**; the table exists so tenancy can come later without migration. Market data stays global; Professional data gets `workspaceId`/`ownerUserId` later.
- No `invites` collection in v1: a pre-approved user is just a `users` row with status `pre_approved`.
- `api_tokens` — userId, name, prefix, `sha256(token)`, scopes, lastUsedAt, expiresAt, revokedAt (used by MCP).
- Audit: reuse existing audit events with the new `user` actor; add `auth.*` events (login, user.pre_approved, user.approved, role.changed, permissions.changed, user.suspended, token.created/revoked).

### Roles and permissions (v1) — APPROVED by owner 2026-10-31 (D9)

- Two roles only: `admin` and `user`. Role is stored as a string enum so `owner`/`operator` can be added later without migration. At least one active `admin` must always exist (cannot demote or suspend the last admin).
- Checks use **permissions, never role names**, e.g. `market.jobs.view`, `market.companies.view`, `sources.health.view`, `sources.run`, `imports.manage`, `users.manage`, `settings.manage`, `professional.view`, `mcp.tokens.create`. `admin` has all permissions.
- **Admin-controlled visibility**: a workspace-level _Settings → User defaults_ page where admin toggles which areas/features users get (Market jobs, Companies, Source health, Professional, MCP access, …), plus per-user **overrides** (grant/revoke) on a user's page. Effective user permissions = defaults + grants − revokes.
- UI hides what is not permitted **and** the server enforces the same check on pages, `/api/*` and MCP (`resolveActor` + a `requirePermission` helper at the API edge, per ADR-0008; domain packages stay unaware). MCP token scopes can never exceed the user's effective permissions (re-checked on every call).
- v1 granularity is area/feature level, not per-record or per-field.

### Flows

1. **Bootstrap**: `ADMIN_EMAIL` env makes that Google account the first admin on first login; shared password stays as a break-glass fallback behind a flag until M-U4.
2. **Add user**: admin adds/pre-approves an email address (no invite email in v1) → that person signs in with Google → `active` with default permissions.
3. **Unknown Google accounts** land as `pending_approval` (no access) until admin approves or rejects them in **Settings → Users**; marketing early-access entries land the same way.
4. **Manage**: list/search users, change role, set per-user overrides, suspend (revokes sessions + tokens), view a user's audit trail.
5. No email sending needed in v1, so D6 (paid email provider) is deferred.

### Milestones (small PRs)

| ID   | PR                                                                                                                         | Acceptance criteria                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| M-U0 | ADR-0022 "User authentication" + FE-5 (`user` actor kind)                                                                  | Owner approves; ADR-0008 marked superseded-in-part.                                                                                      |
| M-U1 | FE-5: add `kind: 'user'` (+ optional `roles`) to `actorSchema`                                                             | Additive only; all existing tests pass; old audit events still parse.                                                                    |
| M-U2 | `packages/identity` + collections + Better Auth wired into `/api/auth/*`                                                   | Google sign-in works locally (pre-approved → active, unknown → pending); sessions revocable; int tests on real Mongo.                    |
| M-U3 | `resolveActor` derives user from session; permissions resolver (defaults + overrides) and `requirePermission` on pages/API | 401 without session, 403 without permission, audit shows user id; last admin cannot be demoted/suspended.                                |
| M-U4 | Login page, Settings → Users (add/pre-approve, approve, role, overrides, suspend) + Settings → User defaults               | E2E: pre-approve → Google sign-in → toggle default/override hides page and API → suspend revokes access. Shared password removed (flag). |
| M-U5 | Marketing early-access → `pending_approval` import                                                                         | Approved request becomes an active user; duplicate emails deduped.                                                                       |
| M-U6 | API tokens (create/list/revoke in Settings)                                                                                | Token shown once, stored hashed, scopes ≤ user permissions, revocation immediate.                                                        |

### Risks

- Auth bugs are high-impact → Extra High review + two independent reviews on M-U2/M-U3; rate-limit login and user-admin endpoints.
- `app.inject()` path must forward cookies/headers correctly — test explicitly.
- Locking the admin out → last-admin rule, break-glass flag and `ADMIN_EMAIL` bootstrap.
- Professional data visibility: until per-user scoping exists, any user granted `professional.view` sees all Professional records → keep `professional.view` off the user defaults (admin-only) until FE-P7/FE-P8.

## 2. UI revamp

### Goals

- Clearer information architecture organised by job-to-be-done (Market, Professional, Operations, Settings) instead of by internal record type.
- A polished, consistent look that can also serve a future user-facing app.
- Keep the design-system non-negotiables (canonical values only, accessible states, tokens only, no lost capability).

### Proposed design

- **Keep the stack**: CSS tokens + CSS Modules (no Tailwind, no UI kit) — the v1 system is already token-driven, so a revamp is mostly new tokens, components and layout, not a rewrite. Option: adopt Radix primitives for complex widgets (combobox, dialog) — owner/supervisor decision, low risk.
- **Tokens v2**: refreshed palette, type scale and density modes; brand alignment with www.aptamind.app.
- **IA / navigation**: Home (what needs attention), Market (Companies, Jobs, Sources, Imports, Review), Professional (Subjects, Documents, Targets), Operations (Runs, Workflows, Capabilities, Health), Settings (Users, Tokens, Preferences). Global command palette (⌘K) and search.
- **Which apps** (decision D3, APPROVED by owner 2026-10-31):
  - _Option 1 (recommended now)_: one Next.js app, two surfaces — `/admin/*` (admins) and `/app/*` (users), permission-gated. No new deployable, no `packages/ui` yet.
  - _Option 2_: separate `apps/web` user app → triggers `packages/ui` extraction (allowed by the 2026-09-29 rule once a second consumer exists), second deployment.
  - Recommend Option 1 until there is a real end-user product scope; it can be split later because components already live in a fenced folder.
- **Migration**: strangler, page by page behind the new shell; old and new pages coexist; each PR keeps route smoke tests green; no pixel snapshots (existing rule).

### Milestones

| ID       | PR                                                                     | Acceptance criteria                                            |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| M-V0     | Design brief + clickable mock (Figma or static HTML)                   | Owner signs off look and IA.                                   |
| M-V1     | Tokens v2 + updated primitives                                         | No hex/raw px lint violations; a11y checks pass in light/dark. |
| M-V2     | New shell: sidebar IA, top bar, user menu, ⌘K                          | All existing routes reachable; nav test updated.               |
| M-V3     | Home "needs attention" dashboard                                       | Uses existing `/api/dashboard`; no derived domain truth.       |
| M-V4..V7 | Migrate Market, Professional, Operations, Settings pages (one PR each) | Route smoke + interaction tests green; no capability dropped.  |
| M-V8     | Remove legacy `globals.css` remnants                                   | Design-system doc updated to v2.                               |

### Risks

- Scope creep (redesign never ends) → fixed page list and sign-off at M-V0.
- Regressions in dense operator screens → keep the capability checklist from design system v1.

## 3. MCP server

### Goals

- Let a signed-in user connect Claude, Cursor or similar to **their** Aptamind data, read-only, with the same permissions they have in the UI.
- It is an _interface_, not an agent: Aptamind runs no autonomous model loop; the external client's model only reads. "AI makes proposals only" still holds.

### Proposed design

- **Where**: a route in the existing Next.js app, `apps/admin/app/api/mcp/route.ts`, using the official `@modelcontextprotocol/sdk` (or `mcp-handler`) with **Streamable HTTP** transport (stateless). It calls the same platform services as `/api/*` — no new deployable, no new data store, no vector DB/RAG. A `stdio` wrapper for local dev is optional.
- **Auth**: `Authorization: Bearer <api token>` from M-U6 (scopes drawn from the user's permissions, e.g. `market.jobs.view`, `professional.view`; never more than the user has). `resolveActor` maps token → user → effective permissions ∩ token scopes, so the same `requirePermission` checks apply. OAuth 2.1 (MCP auth spec) is a later step once a client needs it.
- **Tools (v1, all read-only)**:
  - `search_companies(query, filters)`, `get_company(id)` — incl. sponsorship status with evidence.
  - `search_jobs(query, country, sponsorship, remote, postedSince)`, `get_job(id)`.
  - `list_sources()`, `get_source_health(id)`.
  - `get_dashboard()` — counts and attention items.
  - `list_professional_subjects()`, `get_professional_profile(id)` — only for tokens with `professional.view`, respecting consent/masking.
  - Resources: `aptamind://company/{id}`, `aptamind://job/{id}` for citation.
- **Guardrails**: result size caps + pagination, per-token rate limit, every call audited (`mcp.tool_called` with tool name, not payload), no write tools in v1, Professional tools disabled by default.
- **Later (separate decision)**: proposal-only write tools (e.g. `propose_review_decision`) that create a pending review item a human approves — consistent with "AI makes proposals only".

### Milestones

| ID   | PR                                                                             | Acceptance criteria                                                            |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| M-M0 | ADR-0023 "MCP server (read-only interface)" + decision lifting "no MCP agents" | Owner approves.                                                                |
| M-M1 | `/api/mcp` skeleton, token auth, `get_dashboard`                               | MCP Inspector connects locally; 401 without token; audit event written.        |
| M-M2 | Market tools + resources                                                       | Contract tests per tool; results match `/api` responses; pagination capped.    |
| M-M3 | Professional tools behind scope                                                | Tokens without scope get 403; masking honoured; tests with synthetic subjects. |
| M-M4 | Docs: connect from Claude Desktop / Cursor; rate limits                        | A design partner can connect end to end on preview.                            |

### Risks

- Data exfiltration via a leaked token → hashed tokens, expiry, scopes, revoke, rate limits, audit.
- Prompt-injection from job/company text reaching the client's model → mark tool output as untrusted data in descriptions; no write tools.
- Vercel function time limits for long queries → paginate; keep tools fast.

## 4. Foundation Exceptions needed

- **FE-5** — `packages/contracts`: add `user` actor kind (and optional role/token claims) to `actorSchema`. Additive; must keep old events valid.
- Probably **none** else: identity, MCP and UI live in `apps/admin` and a new composition-level `packages/identity`. If Professional records later need `ownerUserId` on Foundation-owned run/artifact views, that ties into FE-P7/FE-P8.

## 5. Decisions the owner must approve

| ID  | Decision                                                                                 | Recommendation                                                                                                              |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| D1  | Lift the "authentication programme" prohibited-scope rule and supersede ADR-0008 in part | Approve                                                                                                                     |
| D2  | Auth library                                                                             | **APPROVED 2026-10-31:** Better Auth + Mongo, Google provider only (per D10)                                                                 |
| D3  | Separate user-facing app?                                                                | **APPROVED 2026-10-31:** No for now: one Next.js app with `/admin` and `/app` surfaces                                      |
| D4  | Lift "no MCP agents" to allow a **read-only MCP server** (an interface, not an agent)    | Approve, read-only v1                                                                                                       |
| D5  | Tenancy model                                                                            | Single workspace in v1, schema ready for many                                                                               |
| D6  | Email provider for invites (paid)                                                        | **Deferred — not needed in v1** (Google-only login, no invite emails)                                                       |
| D7  | FE-5 (user actor kind)                                                                   | Approve                                                                                                                     |
| D8  | Who can see Professional data                                                            | Admin only (`professional.view` off by default) until FE-P7/FE-P8                                                           |
| D9  | RBAC model                                                                               | **APPROVED 2026-10-31**: `admin`/`user`, permission checks, admin-controlled defaults + per-user overrides, last-admin rule |
| D10 | Login method                                                                             | **APPROVED 2026-10-31**: Google sign-in only; admin pre-approves emails, unknown accounts pending                           |

## 6. Effort (rough, incl. tests and two reviews)

| Area                | PRs | Effort                                                           |
| ------------------- | --- | ---------------------------------------------------------------- |
| Users (M-U0–U6)     | 7   | ~5–8 days (no invite emails; adds permission defaults/overrides) |
| UI revamp (M-V0–V8) | 9   | ~8–12 days (depends on mock sign-off)                            |
| MCP (M-M0–M4)       | 5   | ~3–5 days                                                        |
| **Total**           | 21  | **~3–5 weeks** of focused work                                   |

Milestone order: M-U0 → M-U1 → M-U2 → M-U3 → M-U4 → (M-V0 in parallel from here) → M-U6 → M-M0..M-M2 → M-V1..V8 → M-U5 → M-M3 → M-M4.
