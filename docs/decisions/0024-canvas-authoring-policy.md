# ADR-0024: Canvas authoring policy

- Status: Accepted (owner, 2026-11-28)
- Date: 2026-11-28
- Related: [ADR-0003](0003-workflow-runtime-design.md) (static DAG runtime),
  [ADR-0006](0006-safe-acquisition.md) (SSRF-safe acquisition),
  [ADR-0007](0007-ai-gateway.md) (AI output is a proposal),
  [ADR-0015](0015-capability-idempotency-contract.md) (idempotency contract),
  [ADR-0021](0021-nextjs-api-boundary.md) (Next.js HTTP API; workers run workflows),
  [ADR-0023](0023-mcp-server-worker.md) (MCP server is inbound only)
- Plan: owner-approved canvas end-to-end plan, 2026-11-28 (PR-0 through PR-9; PR-10 deferred)

## Context

The admin canvas at `/workflows/canvas` (PR #30, `@xyflow/react`) can add, drag and connect
nodes, but a canvas-built workflow cannot reliably register or run. Register fails for any
graph that contains Map Fields or For Each: the inspector only edits a Label, and the generated
spec never supplies those capabilities' required `config`. Even after that is fixed, the canvas
emits empty `node.input`. In this runtime, edges are ordering only; data moves solely through
`$ref` input templates, so a registered graph still fails at run time (for example
`core.http_request` needs `input.url`). Several palette labels (`market.resolve_entities`,
`market.ingest_observation`, `market.detect_signal`, `core.mcp_call`) are not registered
capabilities. `POST /api/workflows` blocks only `professional.*` _keys_, not capabilities, and
accepts every registered capability, including ones that mutate canonical Market state. The
palette is not a security boundary.

`docs/programme/streams/admin-ux.md` said the graph/canvas dependency for UX8 would be decided
by ADR, defaulting to a custom SVG layout. PR #30 added `@xyflow/react` without that ADR. This
record accepts the dependency retroactively and sets the authoring policy for the approved
workstream (PR-0 through PR-9).

## Decision

### Delivery

- Implement PR-0 through PR-9 from the approved plan, in that order. Each PR branches off the
  latest `main` after the previous one has merged. No parallel canvas branches.
- **One independent review per PR** (MVP mode). This relaxes the two-review default in
  `CLAUDE.md` for this workstream only.
- No Foundation Exception is required for PR-0 through PR-9. Work lives in `apps/admin`
  (Admin UX and additive composition-layer routes) and, for PR-7/PR-8, additive Market
  capabilities in `packages/market`.
- **PR-10 (MCP Source / `core.mcp_call`) is deferred.** It is not part of this workstream.

### Authoring surface

- `@xyflow/react`, already in `apps/admin` from PR #30, is the accepted graph library for the
  authoring canvas. A custom SVG layout is not required for this workstream.
- Every canvas spec includes a visible **Start** node (`core.manual_trigger`), matching Market
  workflows and the design-system "trigger is the first, visually distinct node" rule. Bindings
  may still use `run.input.*` directly; the Start node is kept for consistency and trigger
  metadata, not because the runtime requires it for run input.
- **Scheduling** canvas workflows (`defaultSchedule`) is out of scope.
- **MCP Source** is removed from the palette in PR-2. There is no MCP _client_ capability today
  (ADR-0023 is an inbound MCP server in the worker). A later client would need a Foundation
  Exception in frozen `packages/workflow-nodes` and a new ADR-0025; that work is not started
  here. Do not leave a greyed-out "coming soon" tile.

### Keys, titles and versions

- Canvas-created workflows must use a `canvas.` key prefix. Keys starting with `professional.`,
  `market.` or `core.` are rejected.
- Registered definitions are labelled `{ origin: 'canvas' }`. Version labels propagate to runs.
- The **key is separate from the title**. The key is auto-slugged from the first title and then
  locked (editable only before the first save). Templates must not overwrite an existing title
  or key.
- The PR #34 title-collision guard (HTTP 409 when a key already has versions) stays in place
  for every non-canvas key. In **PR-6**, a resave of an existing `canvas.*` key whose
  definition is `origin=canvas` calls `catalog.register`: identical content returns the current
  version, a changed spec creates version N+1. That is the only relaxation of the 409.

### Capability allowlist and safety tiers

The server enforces an allowlist on `POST /api/workflows` and on `POST /api/workflows/validate`,
recursively through `for_each` body capabilities/workflows and `core.execute_subworkflow`. The
palette is a convenience, not a boundary.

- **Tier A (allow).** Generic nodes that already exist and are safe to configure: `core.http_request`,
  `core.browser_fetch`, `core.browser_crawl`, `core.parse_csv`, `core.parse_json`,
  `core.map_fields`, `core.filter`, `core.dedupe_records`, `core.for_each`, `core.if`,
  `core.switch`, `core.ai_extract`, `core.load_artifact`, `core.store_artifact`, and
  `core.manual_trigger`. `core.execute_subworkflow` only when the child key is `canvas.*`.
  `core.schedule_trigger` is not offered (scheduling is out of scope). `core.mcp_call` does
  not exist and must not be allowlisted later without a new owner decision. Market reads and
  transforms: `market.determine_employment_intelligence`, `market.interpret_job`,
  `market.dataset_import_report`, `market.locate_*`, `market.map_company_directory`,
  `market.map_ats_board_directory`, `market.parse_register_snapshot`, `market.select_*`,
  `market.report_reinterpret_backfill`. Proposal and review raisers:
  `market.create_review_item`, `market.propose_job_requirements`, and (from PR-8)
  `market.propose_source` / `market.propose_import`. Require `config.scope.allowedHosts` for
  `core.http_request` and `core.browser_*` in canvas workflows. Canvas HTTP/browser nodes stay
  subject to the existing SSRF-safe client (ADR-0006).
- **Tier B (off the palette).** Evidence-writing capabilities (`market.acquire_snapshot`,
  `market.create_company_observation`, `market.write_lifecycle_signals`,
  `market.write_company_change_signals`, `market.check_dataset_unchanged`). They are not offered
  or registerable from the canvas unless the owner later approves optional PR-9.
- **Tier C (reject).** Capabilities that resolve, create, reconcile or otherwise publish
  canonical state, or that mutate sources: including `market.resolve_company`,
  `market.reconcile_company`, `market.process_company_observation`,
  `market.ingest_job_observation`, `process_*_row`, `finalize_*`, `register_job_source`,
  `discover_careers`, `verify_job`, `reconcile_job`, freshness and retention sweeps, and
  similar. **Act steps produce review proposals, not direct canonical writes.**
- **Never.** `professional.*` capabilities, regardless of workflow key.

**Resolve Entities** on the canvas is a read-only preview (`market.preview_company_resolution`,
PR-7) plus `market.create_review_item` to raise a review for ambiguous results. It must not
create or merge canonical companies. **Detect Signal** is dropped from the palette (the
existing signal writers are Tier B).

**AI still only proposes** (ADR-0007). New Act capabilities wrap the existing Market
`ProposalService` (raise-only; a human approves in Review). Proposed sources are forced to
`enabled: false`. The proposing actor is `workflowActor(runId)`, never `system`.

### Authoring flag and access

- A coarse env flag `CANVAS_AUTHORING_ENABLED` gates canvas authoring and the canvas write
  routes. It is on by default in local development and can be turned off in a shared
  deployment. It is read in the admin/composition layer, not added to frozen
  `packages/config` (no Foundation Exception).
- Until D9 RBAC lands, anyone who can use the admin (today: the shared basic-auth password)
  can author and run canvas workflows when the flag is on. A later `workflows.author`
  permission will narrow this.

### MCP

- `start_workflow_run` in `apps/worker/src/mcp/tools/run.ts` **hard-denies** any `canvas.*`
  workflow key even if it appears on `MCP_RUN_WORKFLOW_ALLOWLIST`. Implemented in PR-1.
  ADR-0023 already restricts MCP runs to proposal-only allowlisted workflows; this is an
  additional belt-and-braces rule so a canvas-authored workflow cannot be started through MCP
  by mistake.

## Consequences

- A canvas-built workflow can be saved, started and found in Runs without hand-edited JSON,
  using only Tier A capabilities, once PR-1 through PR-4 have landed.
- Changing the allowlist, turning on Tier B, exposing Detect Signal, or building an MCP
  _client_ node each needs a new owner decision (and, for an MCP client, a Foundation
  Exception and ADR-0025).
- A leaked or overly broad `MCP_RUN_WORKFLOW_ALLOWLIST` still cannot start a `canvas.*`
  workflow.
- Layout positions are not stored on `WorkflowSpec` (no Foundation change to
  `nodeSpecSchema`). Reloading a definition recomputes layout.
