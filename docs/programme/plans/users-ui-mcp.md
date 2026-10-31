# Plan: user accounts, UI revamp and MCP server

- Status: **PROPOSED — not approved.** Nothing here is built until the owner answers the decisions in §5.
- Date: 2026-10-31 · Author: Aptamind bot for Zubair Haider
- Scope: three owner asks — (1) user accounts managed from Admin, (2) UI revamp, (3) an MCP server.
- Order: **Users → UI → MCP.** MCP needs per-user tokens, and the UI revamp needs to know which app(s) and roles exist.

## 0. Where we are (grounding)

| Area | Current state | Files |
| --- | --- | --- |
| Auth | One shared basic-auth password (`ADMIN_PASSWORD`) over every route except `/health`; if unset, the admin is open. | `apps/admin/middleware.ts`, `apps/admin/lib/basic-auth.ts` (PR 4) |
| Actor seam | Every request becomes `unauthenticated-internal-operator`; domain methods already take an `Actor` and audit records it. | `apps/admin/lib/api-server/request-context.ts` (`resolveActor`), `packages/contracts/src/request-context.ts`, ADR-0008 |
| Actor kinds | `system \| internal-operator \| workflow` — no `user` kind. `packages/contracts` is **Foundation (frozen)**. | `packages/contracts/src/request-context.ts`, CLAUDE.md |
| API | Next.js `/api/*` forwards to an embedded Fastify app via `app.inject()`; routes in `lib/api-server/routes/*`. | ADR-0021, `apps/admin/lib/api-server/app.ts` |
| Data | MongoDB collections defined with Zod-derived validators, idempotent index sync. | `packages/db/src/collections.ts` |
| UI | Attio-inspired design system v1: CSS tokens + CSS Modules, no Tailwind, no UI kit, `components/ui` fenced by ESLint; no `packages/ui` until a second React consumer exists. | `docs/design/admin-design-system.md`, `apps/admin/styles/tokens.css`, `apps/admin/components/{ui,shell}`, DECISION_LOG 2026-09-29 |
| Scope rules | CLAUDE.md "Prohibited scope" lists **authentication programme** and **candidate-agent autonomy**; programme rule says "no MCP agents". | `CLAUDE.md`, `docs/programme/DECISION_LOG.md` |

So all three asks need explicit owner decisions to lift current rules.

## 1. User accounts + admin management

### Goals
- Real per-person login replaces the shared password; every audit event names a real user.
- Admin can invite, approve, suspend and change roles of users; early-access requests from www.aptamind.app can become invites.
- Ready for per-user data (Professional) and per-user API tokens (MCP).

### Auth approach — options

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Better Auth + MongoDB adapter** (recommended) | TS-first, Mongo adapter, email/password, magic link, Google OAuth, organizations/roles and API-key plugins built in; sessions in our own DB; no vendor. | Young library, fast-moving API; we must pin and review upgrades. |
| B. Auth.js (NextAuth v5) | Mature, many providers. | Weak credentials/roles story, no orgs or API keys; Mongo adapter + JWT/session split is awkward with Fastify `inject`. |
| C. Own sessions in Mongo | Full control, tiny surface. | We own password hashing, reset, OAuth, rate limiting, CSRF — security risk and effort. |
| D. Hosted (Clerk/Auth0) | Fastest, polished UI. | Paid third-party commitment, personal data leaves our stack, vendor lock-in. |

**Recommendation: A**, sign-in by **magic link + Google** first (no passwords to leak), email/password optional later. Sessions are opaque, httpOnly, `SameSite=Lax` cookies backed by a Mongo `sessions` collection (revocable).

### Data model (new, in a new `packages/identity` composition-level package, not Foundation)
- `users` — `_id`, email (unique, lower-cased), name, status `invited|pending_approval|active|suspended`, `platformRole` `owner|admin|member`, createdAt, lastLoginAt.
- `sessions`, `accounts` (OAuth links), `verifications` — owned by Better Auth.
- `workspaces` + `memberships` (`userId`, `workspaceId`, `role` `admin|operator|viewer`) — **single default workspace in v1**; the table exists so tenancy can come later without migration. Market data stays global; Professional data gets `workspaceId`/`ownerUserId` later.
- `invites` — email, role, invitedBy, tokenHash, expiresAt, acceptedAt.
- `api_tokens` — userId, name, prefix, `sha256(token)`, scopes, lastUsedAt, expiresAt, revokedAt (used by MCP).
- Audit: reuse existing audit events with the new `user` actor; add `auth.*` events (login, invite.sent, invite.accepted, role.changed, user.suspended, token.created/revoked).

### Roles (v1)
- `owner` (Zubair; can do everything incl. role changes), `admin` (manage users, all operator actions), `operator` (current admin capabilities: imports, review, runs), `viewer` (read-only). Authorization checks live at the API edge (`resolveActor` + a `requireRole` helper per route), per ADR-0008; domain packages stay unaware.

### Flows
1. **Bootstrap**: `OWNER_EMAIL` env creates the first owner on first login; shared password stays as a break-glass fallback behind a flag until M-U4.
2. **Invite**: admin enters email + role → invite email (magic link, 7-day expiry, single use) → user signs in → `active`.
3. **Request access**: marketing form entries land as `pending_approval`; admin approves/rejects in a new **Settings → Users** page.
4. **Manage**: list/search users, change role, suspend (revokes sessions + tokens), resend/revoke invites, view a user's audit trail.
5. Email sending needs a provider (e.g. Resend/SES) — a small paid commitment, owner decision.

### Milestones (small PRs)
| ID | PR | Acceptance criteria |
| --- | --- | --- |
| M-U0 | ADR-0022 "User authentication" + FE-5 (`user` actor kind) | Owner approves; ADR-0008 marked superseded-in-part. |
| M-U1 | FE-5: add `kind: 'user'` (+ optional `roles`) to `actorSchema` | Additive only; all existing tests pass; old audit events still parse. |
| M-U2 | `packages/identity` + collections + Better Auth wired into `/api/auth/*` | Login by magic link works locally; sessions revocable; int tests on real Mongo. |
| M-U3 | `resolveActor` derives user from session; `requireRole` on mutating routes | 401 without session, 403 for wrong role, audit shows user id; viewer cannot mutate. |
| M-U4 | Login page, Settings → Users (invite, approve, role, suspend) | E2E: invite → accept → role change → suspend revokes access. Shared password removed (flag). |
| M-U5 | Marketing early-access → `pending_approval` import | Approved request becomes an invite; duplicate emails deduped. |
| M-U6 | API tokens (create/list/revoke in Settings) | Token shown once, stored hashed, scoped, revocation immediate. |

### Risks
- Auth bugs are high-impact → Extra High review + two independent reviews on M-U2/M-U3; rate-limit login and invite endpoints.
- `app.inject()` path must forward cookies/headers correctly — test explicitly.
- Locking the owner out → break-glass flag and `OWNER_EMAIL` bootstrap.
- Professional data visibility: until per-user scoping exists, every active user with `operator` can see Professional records → keep Professional `admin`-only until FE-P7/FE-P8.

## 2. UI revamp

### Goals
- Clearer information architecture organised by job-to-be-done (Market, Professional, Operations, Settings) instead of by internal record type.
- A polished, consistent look that can also serve a future user-facing app.
- Keep the design-system non-negotiables (canonical values only, accessible states, tokens only, no lost capability).

### Proposed design
- **Keep the stack**: CSS tokens + CSS Modules (no Tailwind, no UI kit) — the v1 system is already token-driven, so a revamp is mostly new tokens, components and layout, not a rewrite. Option: adopt Radix primitives for complex widgets (combobox, dialog) — owner/supervisor decision, low risk.
- **Tokens v2**: refreshed palette, type scale and density modes; brand alignment with www.aptamind.app.
- **IA / navigation**: Home (what needs attention), Market (Companies, Jobs, Sources, Imports, Review), Professional (Subjects, Documents, Targets), Operations (Runs, Workflows, Capabilities, Health), Settings (Users, Tokens, Preferences). Global command palette (⌘K) and search.
- **Which apps** (decision D3):
  - *Option 1 (recommended now)*: one Next.js app, two surfaces — `/admin/*` (operators) and `/app/*` (design partners/users), role-gated. No new deployable, no `packages/ui` yet.
  - *Option 2*: separate `apps/web` user app → triggers `packages/ui` extraction (allowed by the 2026-09-29 rule once a second consumer exists), second deployment.
  - Recommend Option 1 until there is a real end-user product scope; it can be split later because components already live in a fenced folder.
- **Migration**: strangler, page by page behind the new shell; old and new pages coexist; each PR keeps route smoke tests green; no pixel snapshots (existing rule).

### Milestones
| ID | PR | Acceptance criteria |
| --- | --- | --- |
| M-V0 | Design brief + clickable mock (Figma or static HTML) | Owner signs off look and IA. |
| M-V1 | Tokens v2 + updated primitives | No hex/raw px lint violations; a11y checks pass in light/dark. |
| M-V2 | New shell: sidebar IA, top bar, user menu, ⌘K | All existing routes reachable; nav test updated. |
| M-V3 | Home "needs attention" dashboard | Uses existing `/api/dashboard`; no derived domain truth. |
| M-V4..V7 | Migrate Market, Professional, Operations, Settings pages (one PR each) | Route smoke + interaction tests green; no capability dropped. |
| M-V8 | Remove legacy `globals.css` remnants | Design-system doc updated to v2. |

### Risks
- Scope creep (redesign never ends) → fixed page list and sign-off at M-V0.
- Regressions in dense operator screens → keep the capability checklist from design system v1.

## 3. MCP server

### Goals
- Let a signed-in user connect Claude, Cursor or similar to **their** Aptamind data, read-only, with the same permissions they have in the UI.
- It is an *interface*, not an agent: Aptamind runs no autonomous model loop; the external client's model only reads. "AI makes proposals only" still holds.

### Proposed design
- **Where**: a route in the existing Next.js app, `apps/admin/app/api/mcp/route.ts`, using the official `@modelcontextprotocol/sdk` (or `mcp-handler`) with **Streamable HTTP** transport (stateless). It calls the same platform services as `/api/*` — no new deployable, no new data store, no vector DB/RAG. A `stdio` wrapper for local dev is optional.
- **Auth**: `Authorization: Bearer <api token>` from M-U6 (scopes `mcp:read`, `market:read`, `professional:read`). `resolveActor` maps token → user → roles, so the same `requireRole` checks apply. OAuth 2.1 (MCP auth spec) is a later step once a client needs it.
- **Tools (v1, all read-only)**:
  - `search_companies(query, filters)`, `get_company(id)` — incl. sponsorship status with evidence.
  - `search_jobs(query, country, sponsorship, remote, postedSince)`, `get_job(id)`.
  - `list_sources()`, `get_source_health(id)`.
  - `get_dashboard()` — counts and attention items.
  - `list_professional_subjects()`, `get_professional_profile(id)` — only for users with `professional:read`, respecting consent/masking.
  - Resources: `aptamind://company/{id}`, `aptamind://job/{id}` for citation.
- **Guardrails**: result size caps + pagination, per-token rate limit, every call audited (`mcp.tool_called` with tool name, not payload), no write tools in v1, Professional tools disabled by default.
- **Later (separate decision)**: proposal-only write tools (e.g. `propose_review_decision`) that create a pending review item a human approves — consistent with "AI makes proposals only".

### Milestones
| ID | PR | Acceptance criteria |
| --- | --- | --- |
| M-M0 | ADR-0023 "MCP server (read-only interface)" + decision lifting "no MCP agents" | Owner approves. |
| M-M1 | `/api/mcp` skeleton, token auth, `get_dashboard` | MCP Inspector connects locally; 401 without token; audit event written. |
| M-M2 | Market tools + resources | Contract tests per tool; results match `/api` responses; pagination capped. |
| M-M3 | Professional tools behind scope | Tokens without scope get 403; masking honoured; tests with synthetic subjects. |
| M-M4 | Docs: connect from Claude Desktop / Cursor; rate limits | A design partner can connect end to end on preview. |

### Risks
- Data exfiltration via a leaked token → hashed tokens, expiry, scopes, revoke, rate limits, audit.
- Prompt-injection from job/company text reaching the client's model → mark tool output as untrusted data in descriptions; no write tools.
- Vercel function time limits for long queries → paginate; keep tools fast.

## 4. Foundation Exceptions needed
- **FE-5** — `packages/contracts`: add `user` actor kind (and optional role/token claims) to `actorSchema`. Additive; must keep old events valid.
- Probably **none** else: identity, MCP and UI live in `apps/admin` and a new composition-level `packages/identity`. If Professional records later need `ownerUserId` on Foundation-owned run/artifact views, that ties into FE-P7/FE-P8.

## 5. Decisions the owner must approve
| ID | Decision | Recommendation |
| --- | --- | --- |
| D1 | Lift the "authentication programme" prohibited-scope rule and supersede ADR-0008 in part | Approve |
| D2 | Auth library | Better Auth + Mongo, magic link + Google |
| D3 | Separate user-facing app? | No for now: one Next.js app with `/admin` and `/app` surfaces |
| D4 | Lift "no MCP agents" to allow a **read-only MCP server** (an interface, not an agent) | Approve, read-only v1 |
| D5 | Tenancy model | Single workspace in v1, schema ready for many |
| D6 | Email provider for invites (paid) | Resend or SES, low volume |
| D7 | FE-5 (user actor kind) | Approve |
| D8 | Who can see Professional data | Owner/admin only until FE-P7/FE-P8 |

## 6. Effort (rough, incl. tests and two reviews)
| Area | PRs | Effort |
| --- | --- | --- |
| Users (M-U0–U6) | 7 | ~6–9 days |
| UI revamp (M-V0–V8) | 9 | ~8–12 days (depends on mock sign-off) |
| MCP (M-M0–M4) | 5 | ~3–5 days |
| **Total** | 21 | **~3–5 weeks** of focused work |

Milestone order: M-U0 → M-U1 → M-U2 → M-U3 → M-U4 → (M-V0 in parallel from here) → M-U6 → M-M0..M-M2 → M-V1..V8 → M-U5 → M-M3 → M-M4.
