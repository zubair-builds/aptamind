# Claude Code Autonomous Execution Prompt — Aptamind Foundation + Market Intelligence

You are the **autonomous supervising implementation agent and principal engineer** for Aptamind's first engineering programme.

Your job is to build a robust shared foundation and the **Market Intelligence** stream described in the repository documents.

You must work autonomously and drive the programme to a coherent, tested, documented state without asking the owner for routine implementation choices, confirmation, sequencing, or architecture preferences.

---

# 1. Authority hierarchy

Use this order of authority:

1. Explicit current owner instructions.
2. `01_MARKET_CONTEXT_AND_REQUIREMENTS.md`.
3. `02_MARKET_PRD.md`.
4. Existing repository architecture/decision records that do not conflict with 1–3.
5. The locked contract for the current milestone.
6. Existing code conventions where they do not conflict with higher authority.
7. Your own implementation judgment.

If lower authority conflicts with higher authority, higher authority wins.

Do not silently rewrite the product or architecture.

If the repository does not yet contain the two documents above, copy them into an appropriate durable repository location such as:

```text
docs/product/market-prd.md
docs/architecture/market-context-and-requirements.md
```

and treat them as authoritative.

---

# 2. Operating mode

Work autonomously.

Do not ask the owner for:

- routine library choices;
- naming choices that do not alter product semantics;
- permission to add tests;
- permission to refactor code you just introduced;
- permission to fix lint/type/test failures;
- permission to create migrations/indexes/configuration required by the locked design;
- confirmation between milestones.

When multiple implementation choices satisfy the contract, choose the simplest production-grade option and document material decisions.

Do not wait between milestones.

Proceed until:

- the defined programme is complete; or
- a genuine external blocker exists that cannot be resolved locally (for example, a required private credential or unavailable external system).

When an external service cannot be called because credentials/network are unavailable, implement the adapter/contract, provide deterministic fixtures or local substitutes, and continue all work that can be completed without that external dependency.

Do not claim a real external integration passed if it was only tested against fixtures.

---

# 3. Scope lock

## Build

- shared repository foundation;
- MongoDB operational persistence;
- Redis/BullMQ queue/execution transport;
- S3-compatible object storage abstraction with local development support;
- generic Aptamind workflow/execution runtime;
- capability/node SDK + registry;
- typed generic nodes required by Market;
- Market sources;
- raw snapshots/artifacts;
- company/job observations;
- provenance/confidence;
- company entity resolution;
- canonical Company;
- careers/ATS discovery;
- Greenhouse/Ashby/Lever adapters;
- canonical Job;
- job entity resolution;
- job lifecycle/freshness;
- employment/location/remote/sponsorship intelligence;
- salary normalization;
- structured job requirements;
- reconciliation;
- review queue;
- verification workflows;
- admin operational UI;
- observability;
- tests/evaluations/golden fixtures;
- documentation/runbooks.

## Do not build

- authentication;
- authorization/RBAC;
- billing/subscriptions;
- Professional Intelligence;
- Opportunity Intelligence/matching;
- resume/cover-letter generation;
- candidate job feed;
- browser extension;
- outreach;
- portfolio builder;
- marketplace;
- employer ATS;
- generic public automation product;
- plugin marketplace;
- full drag/drop workflow canvas;
- arbitrary unsafe code execution;
- Kafka;
- Temporal unless a demonstrated blocker makes BullMQ unable to satisfy a locked requirement;
- Neo4j;
- ClickHouse/warehouse;
- dedicated vector DB;
- dedicated search cluster;
- microservices;
- mandatory Kubernetes.

Authentication is explicitly **out of scope**. Do not introduce it.

Preserve a seam so request actor/auth can be added later without changing domain APIs.

---

# 4. Required architectural shape

Build a **modular monolith + asynchronous worker system**.

Recommended repository shape:

```text
apps/
  api/
  worker/
  admin/

packages/
  contracts/
  db/
  queue/
  storage/
  observability/
  ai/
  taxonomy/
  provenance/

  workflows/
  workflow-sdk/
  workflow-nodes/

  market/
    companies/
    jobs/
    signals/
    sources/
    observations/
    resolution/
    enrichment/
    reconciliation/
    verification/
    freshness/
    review/
    workflow-nodes/
```

You may refine directories if the domain boundaries remain equivalent and clearer.

Do not collapse everything into `utils`, `services`, or `common`.

---

# 5. Technology decisions

Unless the existing repository already has a compatible locked choice, use:

- TypeScript strict mode;
- Node.js supported modern LTS;
- pnpm workspaces;
- Fastify for internal API (or retain an existing equivalent if already established);
- React/Next.js for admin;
- MongoDB official driver + explicit runtime schemas (Zod or equivalent);
- Redis + BullMQ;
- S3-compatible object storage; MinIO-compatible local development;
- Playwright for browser acquisition/crawling where required;
- native/fetch/undici-style HTTP client;
- Pino-compatible structured logging;
- OpenTelemetry-compatible trace/metrics seam;
- Vitest or repository-standard test runner;
- Docker Compose or equivalent local services for Mongo/Redis/object storage;
- CI for lint/typecheck/test/build.

Do not add an ODM merely for convenience if it obscures Mongo behavior.

Do not use Mongo's flexible schema as justification for `any` or unvalidated arbitrary JSON.

---

# 6. Core architecture laws

These are locked.

## Law A — observation is not truth

External input flows through:

```text
Source
-> Raw Snapshot / Artifact
-> Observation
-> Interpretation / Normalization
-> Entity Resolution
-> Reconciliation
-> Canonical Intelligence
```

No source connector may directly overwrite canonical Company/Job truth.

## Law B — workflow != business logic

The workflow runtime orchestrates.

Market domain modules own business meaning and policies.

Do not duplicate domain rules in arbitrary workflow prompts/scripts.

## Law C — workflow runtime is generic

It knows no company/job semantics.

It executes versioned capabilities with typed contracts.

## Law D — flexible capability granularity

The runtime must support both low-level generic primitives and sophisticated future capabilities without changing the engine contract.

## Law E — durable state in Mongo

BullMQ is transport, not workflow truth.

## Law F — idempotency

Retries must not create duplicate canonical entities/observations/side effects.

## Law G — ambiguity is explicit

Unknown/conflicting data remains unknown/conflicting or enters review. Never fabricate certainty.

## Law H — AI cannot directly mutate canonical truth

Structured AI output -> schema/domain validation -> reconciliation/review -> canonical.

---

# 7. Foundation milestones

Execute milestones sequentially, but keep commits and boundaries clean.

## F0 — repository and infrastructure foundation

If repository is empty, bootstrap it.

Deliver:

- workspace/monorepo;
- apps/admin;
- apps/worker;
- apps/admin;
- shared TypeScript/lint/format/test config;
- environment/config validation;
- Mongo connection package;
- Redis/BullMQ package;
- S3-compatible storage package;
- local Docker Compose services;
- structured logging;
- health/readiness endpoints;
- CI;
- initial docs/ADRs.

Acceptance:

- one documented local command boots infrastructure;
- API starts;
- worker starts;
- admin starts;
- health checks pass;
- lint/typecheck/unit tests/build pass.

Do not add auth.

## F1 — durable workflow runtime

Implement:

```text
WorkflowDefinition
WorkflowVersion
WorkflowRun
NodeRun
Capability Registry
```

Requirements:

- immutable workflow versions;
- exact node version recorded per run;
- durable run/node state in Mongo;
- BullMQ dispatch;
- retry policy;
- timeout;
- cancellation seam;
- idempotency;
- manual trigger;
- schedule trigger;
- control/fan-out with bounded concurrency;
- subworkflow invocation;
- artifact references;
- run logging/metrics;
- waiting/review-compatible state.

Initial generic capabilities as required by first Market flows:

- Manual Trigger;
- Schedule Trigger;
- HTTP Request/Download;
- Browser Fetch;
- bounded Browser Crawl if needed;
- Parse CSV;
- Parse JSON;
- Map/Filter;
- For Each;
- If/Switch;
- Structured AI Extract;
- Store/Load Artifact;
- Execute Subworkflow.

Do not implement unsafe arbitrary code execution.

Acceptance tests must prove:

- workflow survives API restart;
- node retry does not duplicate side effects;
- fan-out is bounded;
- failed node/run is inspectable;
- raw artifact can be reloaded/reprocessed.

---

# 8. Market milestones

## M1 — Sources, snapshots, observations, Company core

Implement:

- Source model/API/admin;
- source health and scheduling metadata;
- source governance metadata seam;
- RawSnapshot/Artifact integration;
- CompanyObservation;
- canonical Company;
- evidence/provenance references;
- confidence;
- ReviewItem;
- Company resolution/reconciliation.

Company model must support at minimum:

- identity/name/aliases/domain/website;
- industries/stage/classification seam;
- employee estimate/range;
- founded/funding stage seam;
- HQ/locations/hiring regions;
- careers URL/ATS;
- remote-policy observations;
- sponsorship capability;
- relocation support;
- freshness/provenance/conflicts.

Entity resolution:

1. exact official domain/source ID;
2. alias;
3. normalized name;
4. fuzzy/semantic only as fallback;
5. review on meaningful ambiguity.

Do not auto-merge risky ambiguous companies.

## M2 — first real company-universe workflow

Implement the UK sponsor dataset vertical slice.

The system must support this flow:

```text
Manual/Schedule Trigger
-> Download dataset
-> Store Artifact
-> Parse CSV
-> Map -> CompanyCandidate
-> Resolve Company
-> Create Company Observation
-> Reconcile/Publish Company
-> Review ambiguity
```

Semantic requirement:

- sponsor-registry presence = company capability/licence evidence;
- it must NOT become `this job sponsors = yes`.

Use real external integration if network/access is available.

Also provide committed fixtures so tests do not depend on live network.

Prove idempotency with repeated execution.

## M3 — careers/ATS discovery and Job core

Implement:

- Discover Careers capability;
- Detect ATS capability;
- discovered Job Source registration;
- Greenhouse adapter;
- Ashby adapter;
- Lever adapter;
- generic careers/browser fallback seam;
- JobObservation;
- canonical Job;
- job entity resolution;
- job lifecycle.

Canonical Job model must support the fields in the authoritative context document.

Job source adapters must output shared JobObservation contracts.

Provider payload shape must not leak into canonical jobs.

Job lifecycle must distinguish source failure from job absence/closure.

## M4 — employment and job intelligence

Implement robust structured interpretation for:

- normalized role/title;
- role family/specialization;
- seniority;
- requirements with critical/important/preferred/incidental;
- employment type;
- listed/normalized locations;
- work model;
- remote scope;
- allowed/excluded geographies;
- timezone/office constraints;
- sponsorship explicit yes/no/unclear;
- company sponsorship capability as separate evidence;
- authorization requirement;
- relocation;
- compensation normalization;
- responsibilities/scope signals.

Do not reduce remote to a boolean.

Explicit job statements override generic company assumptions for that role.

Unknown stays unknown.

AI may extract/interpret but deterministic policy should derive downstream canonical classifications where practical.

## M5 — verification, freshness, operational hardening

Implement:

- freshness policies;
- due-for-refresh queries;
- job verification workflows;
- source health;
- review queue UX;
- company/job provenance UX;
- workflow/run inspection;
- data-quality metrics;
- failure/retry visibility;
- golden fixture suite;
- operational runbooks.

Do not mass-close jobs because one fetch failed.

---

# 9. Admin application

Build an internal operations UI with no auth.

Required areas:

```text
Dashboard
Sources
Workflows
Workflow Runs
Companies
Jobs
Review
```

Do not build a full visual workflow canvas yet.

Workflow definitions may initially be code/config-backed and displayed read-only in a clear graph/list representation.

UI must use internal API contracts, not database imports/direct access.

---

# 10. AI design

Create a provider-neutral AI gateway.

The first implementation may use one available provider, but domain code must not depend directly on that provider SDK.

AI calls producing domain data must:

- use structured outputs;
- validate against schemas;
- record model/provider;
- record prompt/template version;
- record input provenance;
- record latency/cost metadata where available;
- fail safely;
- never silently mutate canonical truth.

If no AI credentials exist locally, keep interfaces complete and use deterministic fixtures/fakes in automated tests. Continue all non-AI work.

---

# 11. Source and crawler safety

Implement safeguards:

- URL validation;
- SSRF protection;
- allowed protocols;
- private-network blocking unless explicitly configured for development;
- crawl host/domain scope;
- max pages/depth;
- request timeout;
- rate/concurrency limits;
- content-size limits;
- clear user agent/config seam;
- no arbitrary browser navigation outside configured scope.

Preserve source metadata for terms/access/governance review.

Do not design around prohibited scraping of private/authenticated third-party systems.

---

# 12. Data/versioning requirements

Every important canonical/derived document must have:

- `schemaVersion`;
- `createdAt`;
- `updatedAt`.

Derived intelligence should also retain as applicable:

- `logicVersion`;
- `policyVersion`;
- `taxonomyVersion`;
- `promptVersion`;
- `modelVersion`;
- `computedAt`;
- evidence/observation refs.

Workflow runs must retain exact workflow and capability/node versions.

---

# 13. Indexing requirements

Do not postpone indexes until production.

Define indexes intentionally for at least:

- unique/normalized company domain;
- company aliases/external IDs where appropriate;
- job company + external requisition ID;
- canonical/application URL fingerprints;
- source ID + external IDs;
- workflow/run state;
- schedule/due queries;
- job lifecycle/freshness queries;
- review status/priority;
- observation source/entity/time queries.

Document uniqueness assumptions.

---

# 14. Testing requirements

Do not declare a milestone complete without tests.

## Unit

Cover:

- workflow state machine;
- idempotency;
- normalization;
- company resolution;
- job resolution;
- reconciliation;
- lifecycle transitions;
- salary normalization;
- remote/location policy;
- sponsorship policy;
- capability schema validation.

## Integration

Cover:

- Mongo persistence;
- BullMQ dispatch/retry;
- storage artifacts;
- multi-node workflow;
- source -> observation -> canonical;
- worker restart/retry semantics where practical;
- review generation.

## Golden fixtures

Create fixtures representing difficult real cases:

- same company with aliases;
- two similar but distinct companies;
- same job syndicated across sources;
- repost;
- `Remote` heading but US-only body text;
- EMEA-only remote;
- timezone-only remote;
- company sponsor-capable but role silent;
- explicit no sponsorship;
- salary in GBP/USD/EUR/AED and hourly/monthly/yearly;
- malformed salary;
- failed source fetch;
- job removed from source;
- conflicting third-party vs official source.

Create an evaluation command that runs these golden cases.

---

# 15. Documentation requirements

Maintain:

```text
docs/architecture/system-overview.md
docs/architecture/workflow-runtime.md
docs/architecture/market-domain.md
docs/architecture/data-model.md
docs/decisions/
docs/runbooks/local-development.md
docs/runbooks/source-failure.md
docs/runbooks/reprocessing.md
```

Also document:

- how to create a generic capability;
- how to create a Market domain capability;
- how to add a connector/provider adapter;
- how to add a workflow template;
- how to add/reprocess a source;
- how to resolve review items;
- how canonical provenance is traced.

Record material architectural choices as ADRs.

---

# 16. Git and change discipline

If the repo is already under Git:

- preserve history;
- do not destructive-reset unrelated work;
- keep changes scoped;
- commit coherent milestones if normal project conventions permit commits;
- never force-push.

If the repo is empty but initialized, bootstrap in place.

If it is not initialized and this prompt is being run specifically to create Aptamind, initialize a repository only if appropriate to the environment; otherwise build the file tree without inventing remote repository configuration.

Do not create fake secrets.

Provide `.env.example` with documented variables.

---

# 17. Quality bar

The target is not a demo.

The result should be:

- modular;
- type-safe;
- schema validated;
- idempotent;
- retry-safe;
- observable;
- testable;
- documented;
- reproducible;
- production-oriented;
- simple enough to operate;
- extensible without speculative infrastructure.

Avoid both extremes:

- naive scraper scripts with no provenance/state; and
- overengineered distributed infrastructure before need exists.

---

# 18. Autonomous decision policy

When uncertain:

1. Prefer the architecture laws and domain invariants.
2. Prefer deterministic policy over opaque model judgment for critical classifications.
3. Prefer explicit unknown over invented value.
4. Prefer preserving raw evidence over discarding it.
5. Prefer idempotent append/observation patterns over direct destructive updates.
6. Prefer one robust implementation over many shallow integrations.
7. Prefer simple infrastructure that can evolve later.
8. Prefer tests/golden fixtures over prompt intuition.
9. Prefer admin review for ambiguous high-impact data.
10. Do not add unrelated product features.

---

# 19. Required execution procedure

At the start:

1. Inspect repository tree, package manager, existing docs, code, git state, and tests.
2. Compare current state to the authority documents.
3. Create/update a concise implementation status document, for example:

```text
docs/execution/market-foundation-status.md
```

with milestones F0/F1/M1–M5 and current state.

4. Create a todo/execution plan derived from actual repository state.
5. Execute the plan.

For every milestone:

1. implement;
2. run formatting/lint/typecheck/tests/build relevant to the changed scope;
3. fix failures;
4. run milestone acceptance checks;
5. update docs/status;
6. continue automatically.

Do not stop simply because one milestone completed.

---

# 20. Completion report

When the programme is complete, provide a concise final report containing:

- milestones completed;
- architecture delivered;
- important ADRs;
- test/build commands and results;
- real integrations exercised vs fixture-only integrations;
- known limitations;
- remaining follow-up work that is outside the locked programme;
- exact current repo status/branch/commit if available.

Do not call incomplete work complete.

---

# 21. Start now

Begin by inspecting the repository and authority documents.

If the repository is empty, bootstrap F0.

If foundations already exist, reuse what satisfies the contract and do not rebuild unnecessarily.

Then execute **F0 -> F1 -> M1 -> M2 -> M3 -> M4 -> M5** autonomously.

Do not implement authentication.

Do not implement Professional Intelligence or Opportunity Intelligence.

Build the robust reusable Aptamind foundation and Market Intelligence layer.
