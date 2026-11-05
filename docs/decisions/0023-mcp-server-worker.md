# ADR-0023: MCP server in the local worker (interface, not agent)

- Status: Accepted (owner, relayed by Manager); amended 2026-11-05
- Date: 2026-11-02
- Revises: owner decision D4 in [users-ui-mcp](../programme/plans/users-ui-mcp.md) (2026-10-31)
- Related: [ADR-0021](0021-nextjs-api-boundary.md) (Next.js owns the HTTP API; workers run
  workflows), [ADR-0022](0022-user-authentication.md) (per-user API tokens, M-U6, later)

## Context

D4 placed an MCP server at `/api/mcp` in the admin app, authenticated by per-user scoped API
tokens. Those tokens (M-U6) do not exist yet, and the owner wants cloud AI bots to read Aptamind
data and start proposal-only workflows now. The worker already holds the Mongo, Redis and runtime
services the tools need (`apps/worker/src/main.ts`), and it runs on the owner's machine.

## Decision

- **Where.** The MCP server runs inside the worker process (`apps/worker`), on its own HTTP port,
  using the official `@modelcontextprotocol/sdk` (Streamable HTTP, stateless). It is off unless
  `MCP_ENABLED=true`. It is a separate listener from the health server (which stays private on
  `WORKER_METRICS_PORT`) and is bound to `127.0.0.1` only. The server validates the `Origin`
  and `Host` headers on every request (rejecting unexpected values) as the standard Streamable
  HTTP safeguard against DNS rebinding, in addition to the loopback bind and the bearer token.
- **Exception to ADR-0021.** ADR-0021 makes the Next.js app the only HTTP API deployable and the
  worker the place where workflows run. Serving MCP from the worker is an explicit, temporary
  exception to that boundary: it lasts until per-user tokens (M-U6) exist, when MCP moves to
  `/api/mcp` in the admin app as originally planned in D4.
- **Exposure.** Remote clients reach it only through a Cloudflare Tunnel the owner runs
  (`docs/runbooks/mcp-cloudflare-tunnel.md`). Cloudflare Access with a Service Auth policy in
  front of the tunnel is **required** for any non-local use; the code cannot enforce it, so the
  runbook makes it a mandatory step. Plain `127.0.0.1` use without a tunnel needs no Access.
- **Auth.** One shared bearer token, `MCP_TOKEN` (at least 32 characters). Compared in constant
  time (`sha256` of both sides, then `crypto.timingSafeEqual`). Never logged. The worker refuses to
  start the MCP server when it is enabled without a valid token. Per-user tokens (D4/M-U6) replace
  this later; this ADR does not change ADR-0022. The one token grants every read tool and
  `start_workflow_run`; the allowlist is the only thing scoping the run tool.
- **Actor.** Every call acts as `{ kind: 'internal-operator', id: 'mcp' }`. No new actor kind
  (that would be a Foundation Exception in `packages/contracts`).
- **Tools.** Read: dashboard, jobs, companies, sources (with health), workflows, runs
  (`list_runs` / `get_run`). Run: `start_workflow_run`, only for keys in
  `MCP_RUN_WORKFLOW_ALLOWLIST`; an empty or unset list denies every workflow. The initial list is
  `market.job.propose_requirements`, which stores a proposal, never canonical data. An
  `idempotencyKey` is required, and the input is validated against the workflow version's stored
  `inputSchema` in the tool, because the engine does not validate it.
- **AI only proposes.** No edit or delete tools. Allowlisting a workflow that writes canonical
  state directly (acquisition, careers discovery, reinterpretation) is not allowed without a new
  owner decision. `import_leads` and `propose_source` are covered by the amendment below.
- **Audit.** Every call, including denied, rate-limited and failed ones, writes one Market
  `audit_events` record: action `mcp.<tool>`, entity `{ kind: 'mcp_call', id }`, details with
  tool, outcome, duration, result count and a redacted argument summary (never the token, never
  full payloads). Audit writes go through the Market audit service, never a raw collection
  write. To stop unauthenticated tunnel traffic growing `audit_events` without limit, denied
  (401) and rate-limited (429) calls are aggregated: at most one record per outcome per minute,
  carrying a `count` of the calls it covers. Cloudflare Access is the primary mitigation.
- **Rate limits.** In-process token buckets: 60 read calls and 10 run calls per minute. The limit
  is per worker process, so only one worker may enable MCP. A limited call gets HTTP 429 with a
  `Retry-After` header (seconds until a token is available) and an MCP error saying the rate
  limit was hit. Buckets are in memory and reset when the worker restarts.
- **Config.** `MCP_ENABLED`, `MCP_PORT` (default 4102), `MCP_TOKEN`, `MCP_RUN_WORKFLOW_ALLOWLIST`
  are read and validated in the worker bootstrap, not added to the frozen `packages/config`
  (no Foundation Exception).
- **Privacy.** Read tools return list/summary views with capped pages; run tools strip input,
  output and artifacts; Professional workflows and runs are filtered out (`professional.*`).

## Consequences

- MCP is available only while the local worker is running.
- The worker that serves MCP also runs workflows and the scheduler; handlers must stay small so
  they never starve lease heartbeats.
- A leaked `MCP_TOKEN` gives full use of the tools until rotated; rotation is a restart with a new
  value.

## Amendment 2026-11-05: proposal review for `import_leads` and `propose_source`

Owner decision (approved 3a/3b, relayed by Manager): both tools are added, and both are
proposal-only.

- `import_leads` creates an `import_proposal` and `propose_source` creates a `source_proposal`
  review item in the existing Market review flow. Neither tool ingests leads or registers a
  source directly.
- Only an admin approves or rejects a proposal, through the existing review UI/API. The MCP actor
  (`internal-operator:mcp`) can never approve its own proposals.
- Approval runs the normal Market path (the import pipeline, or source registration). The file and
  input checks run before the approval is saved, so a proposal that fails them is not marked
  resolved. Approval never writes canonical data except through that normal path.
- Delivery: PR #17 adds the review types (3a); the two worker tools follow in a separate PR (3b).
