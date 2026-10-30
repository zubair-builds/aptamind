# Aptamind Market Foundation & Market Intelligence
## Architecture Context, Engineering Requirements, and Domain Contract

**Status:** Initial implementation authority  
**Programme:** Aptamind Phase 1 — Market Intelligence  
**Authentication:** Explicitly out of scope  
**Primary architecture:** Modular monolith + asynchronous workers  
**Operational database:** MongoDB  
**Queue/execution transport:** Redis + BullMQ  
**Object storage:** S3-compatible  

---

# 1. Purpose

This document defines the context and engineering requirements for the first Aptamind build programme: a robust shared foundation plus the **Market Intelligence** stream.

The Market stream exists to turn messy, heterogeneous, changing external information into a trustworthy and continuously maintainable model of:

- companies;
- jobs;
- employment constraints;
- sources;
- observations;
- signals;
- freshness;
- provenance;
- confidence;
- conflicts;
- review state.

The system is **not a scraper application**. Scraping is only one acquisition mechanism.

The system is also **not a generic public Zapier/n8n competitor**. It should, however, have a generic execution substrate inspired by mature orchestration/automation systems so future Aptamind domains can reuse it without redesign.

The immediate architectural thesis is:

> External data is observation, not truth. Workflows acquire and transform observations. Market domain logic resolves, reconciles, enriches, verifies, and publishes canonical intelligence.

---

# 2. Product context

Aptamind's long-term product combines two independent intelligence systems:

1. **Market Intelligence** — what companies and opportunities exist, what is actually true about them, whether they are current, and what employment constraints apply.
2. **Professional Intelligence** — who the professional is, what they have done, what evidence supports it, what they want, and what they have confirmed.

A future **Opportunity Intelligence** domain will connect them.

The dependency direction is locked:

```text
Market Intelligence ───────┐
                           ├──> Opportunity Intelligence
Professional Intelligence ┘
```

Market Intelligence must not depend on Professional Intelligence or Opportunity Intelligence.

This programme builds Market first because it provides a concrete proving ground for the generic execution platform, source provenance, asynchronous workflows, entity resolution, AI-assisted structured interpretation, freshness, review, and operational quality.

---

# 3. Architecture laws

These are non-negotiable unless explicitly changed by the owner.

## 3.1 External observation is not canonical truth

A source saying that a job is "Remote" does not directly write `job.remote = true`.

The system stores the source observation, derives structured interpretations, reconciles competing evidence, and then updates canonical intelligence according to explicit policy.

```text
Source
  -> Raw Snapshot
  -> Observation
  -> Interpretation / Normalization
  -> Entity Resolution
  -> Reconciliation
  -> Canonical Intelligence
```

## 3.2 Workflow orchestration is separate from domain intelligence

Workflows coordinate execution.

Domain modules own business meaning.

Bad design:

```text
Workflow A embeds sponsorship policy in an LLM prompt.
Workflow B uses different sponsorship logic in a script.
```

Correct design:

```text
Workflow A -> Determine Sponsorship capability
Workflow B -> Determine Sponsorship capability

Market domain owns the policy and output contract.
```

## 3.3 The workflow engine is domain-agnostic

The runtime must not know about companies, jobs, CVs, repositories, or signals.

It knows:

- workflows;
- workflow versions;
- nodes/capabilities;
- edges;
- inputs/outputs;
- triggers;
- runs;
- step state;
- retries;
- timeouts;
- cancellation;
- fan-out/concurrency;
- artifacts;
- credential references;
- human waits/review;
- idempotency;
- observability.

## 3.4 Capability granularity is flexible

The execution engine must support both:

- low-level primitives such as HTTP request, parse file, browser fetch, map, filter, AI structured extraction;
- sophisticated reusable capabilities such as Resolve Company, Research Entity, Understand Job, Verify Job, or future deep repository/portfolio analysis.

The runtime contract must not change when a new sophisticated capability is introduced.

## 3.5 Domain truth is typed and versioned

MongoDB flexibility must not become schema anarchy.

All canonical domain documents and durable workflow contracts require:

- runtime validation;
- schema versioning;
- explicit indexes;
- backward-compatible migration strategy or explicit migration;
- timestamps;
- deterministic IDs/references where appropriate.

## 3.6 AI does not directly own truth

AI can:

- extract;
- classify;
- interpret;
- propose;
- summarize;
- reason over evidence.

AI output must pass:

1. structured-output/schema validation;
2. domain validation;
3. provenance attachment;
4. confidence/policy handling;
5. reconciliation/review when required.

## 3.7 Workflow state lives in MongoDB

BullMQ is execution transport, not workflow truth.

Durable state for workflows and node runs must live in MongoDB.

A queue retry, worker crash, Redis restart, or process restart must not erase execution state.

## 3.8 Side effects are idempotent

Every side-effecting operation must have an idempotency strategy.

A retry must not duplicate:

- companies;
- jobs;
- observations;
- snapshots;
- review items;
- source registrations;
- canonical updates.

## 3.9 Ambiguity is represented, not hidden

When confidence is insufficient:

- preserve competing evidence;
- mark unknown/uncertain;
- create a review item when material;
- never invent precision.

## 3.10 No auth in this programme

Do not implement authentication or authorization.

Preserve a future seam around request context/actor identity so auth can be introduced later.

Until then, admin UI/API is internal-only.

---

# 4. Technical baseline

Use a boring, production-oriented TypeScript stack.

## 4.1 Repository

Recommended:

- pnpm workspaces;
- monorepo;
- TypeScript strict mode;
- shared lint/format/typecheck/test configuration;
- CI on every change;
- environment validation.

A lightweight task runner such as Turborepo may be used if it simplifies dependency-aware scripts, but it is not itself an architecture requirement.

## 4.2 Applications

```text
apps/
  admin/
  worker/
```

### `apps/admin`

Responsibilities:

- internal Market and workflow API through Next.js route handlers;
- source/company/job/review API;
- health/readiness endpoints;
- no worker-heavy execution inline.

### `apps/worker`

Responsibilities:

- workflow/node execution;
- scheduled ingestion;
- enrichment;
- verification;
- browser/crawler workloads;
- AI-assisted extraction;
- async reconciliation tasks.

Workers should be horizontally scalable by queue/capability class.

Recommended: Next.js/React.

No auth.

Initial purpose:

- inspect sources;
- run workflows;
- inspect workflow runs;
- inspect companies/jobs;
- resolve review items;
- see operational/data-quality state.

Do not build a full visual workflow canvas in the first milestone. Code/config-authored workflows and templates are sufficient initially.

---

# 5. Package boundaries

Recommended conceptual structure:

```text
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

Avoid a giant `common` package.

Shared packages must contain genuine cross-domain primitives, not leaked Market business logic.

---

# 6. Persistence

## 6.1 MongoDB

MongoDB is the operational source of truth for:

- workflows/runs;
- sources;
- observations;
- canonical companies/jobs/signals;
- review items;
- audit events;
- derived market intelligence.

Use the official MongoDB driver unless a specific ODM materially improves correctness without hiding database behavior.

Runtime schemas should be explicit, e.g. Zod or equivalent.

Important collections should also use MongoDB validation where practical.

## 6.2 Redis/BullMQ

Use Redis/BullMQ for:

- job dispatch;
- worker queues;
- delayed execution;
- retry transport;
- concurrency control;
- scheduled trigger dispatch where appropriate.

Do not store the only copy of workflow state in Redis.

## 6.3 Object storage

Use S3-compatible storage for:

- raw HTML;
- JSON payloads too large/important to keep inline;
- downloaded CSV/XLSX/XML;
- screenshots if later required;
- crawl snapshots;
- source artifacts.

For local development, support MinIO or an equivalent S3-compatible local service.

MongoDB stores immutable ArtifactRefs containing at minimum:

```text
artifactId
storageKey
mimeType
size
sha256/hash
createdAt
source/run context
```

---

# 7. Generic Aptamind Execution Platform

The Market stream is the first major consumer, but the runtime is Aptamind-wide.

## 7.1 Workflow model

Minimum durable concepts:

```text
WorkflowDefinition
WorkflowVersion
WorkflowRun
NodeRun
```

A workflow definition is immutable by version.

Editing a workflow creates a new version.

Historical runs always reference the exact workflow version and node versions they executed.

## 7.2 Workflow requirements

Support:

- manual trigger;
- schedule trigger;
- event/webhook-ready trigger seam;
- directed graph execution;
- conditional branch;
- fan-out / for-each;
- bounded concurrency;
- subworkflow invocation;
- retry policy;
- timeout policy;
- cancellation;
- resume/retry from failed step where safe;
- waiting/human-review state;
- artifacts by reference;
- structured outputs;
- per-step metrics/logs/errors;
- idempotency keys;
- run lineage.

A static DAG with controlled dynamic fan-out is sufficient initially. Do not build a fully general distributed process language.

## 7.3 Node/capability registry

All executable units are registered capabilities.

Conceptual contract:

```ts
interface CapabilityDefinition<Input, Output, Config> {
  type: string;
  version: number;
  inputSchema: Schema<Input>;
  outputSchema: Schema<Output>;
  configSchema: Schema<Config>;
  execution: {
    retryable: boolean;
    defaultTimeoutMs?: number;
    idempotency?: 'required' | 'optional' | 'none';
    sideEffects?: boolean;
  };
  execute(ctx: CapabilityContext, input: Input, config: Config): Promise<Output>;
}
```

The concrete API can vary, but these semantics are required.

## 7.4 Initial generic capabilities

Build only what the first Market workflows actually require.

Likely initial set:

### Trigger/control

- Manual Trigger
- Schedule Trigger
- If/Switch
- For Each / Map with bounded concurrency
- Execute Subworkflow

### Acquisition

- HTTP Request / Download
- Browser Fetch
- Browser Crawl (limited/scoped)
- RSS Fetch if needed

### Parsing/transformation

- Parse CSV
- Parse JSON
- Parse XML/HTML as required
- Map Fields
- Filter
- Deduplicate records
- Structured AI Extract

### Storage

- Store Artifact
- Load Artifact

Arbitrary user-authored code execution is **not required** for the first version. The architecture must permit future sandboxed script capabilities, but do not pretend Node's `vm` is a safe security boundary. Source-specific code can initially be implemented as registered code-defined capabilities.

## 7.5 Domain capabilities

Market domain capabilities should be callable from any workflow and remain canonical:

- Create Source Observation
- Resolve Company
- Reconcile Company
- Discover Careers Source
- Detect ATS
- Resolve Job
- Reconcile Job
- Interpret Job
- Determine Employment Constraints
- Verify Job
- Create Review Item
- Publish/Update Canonical Company
- Publish/Update Canonical Job

Do not duplicate these policies across workflows.

## 7.6 Subworkflows and capability evolution

Allow a proven workflow/subworkflow to be reused as one logical step.

Evolution pattern:

```text
novel problem
-> compose generic capabilities
-> run successfully
-> repeat pattern
-> extract reusable subworkflow/domain capability
```

Do not predict and hard-code every future workflow category.

---

# 8. Sources

A Source is the durable definition of an information origin.

It answers:

- what is the origin?
- what does it provide?
- how is it acquired?
- how often is it checked?
- what authority does it have for particular facts?
- what is its health/freshness state?

## 8.1 Source shape

At minimum:

```text
id
name
kind/category
provider
endpoint/url or artifact configuration
capability/connector reference
schedule/freshness policy
enabled
configuration
health
lastAttemptAt
lastSuccessAt
failure metadata
createdAt
updatedAt
schemaVersion
```

Potential source categories:

- company universe;
- job source;
- signal source;
- manual import;
- user-submitted source later.

These categories belong to Market metadata, not the generic workflow runtime.

## 8.2 Source governance seam

Preserve metadata fields for future source governance:

- access method;
- terms/commercial-rights notes;
- retention restrictions;
- redistribution restrictions;
- crawl policy;
- rate limits;
- last compliance review.

Do not build a compliance-management product now, but do not design sources as bare URLs either.

---

# 9. Raw snapshots and observations

## 9.1 Raw snapshots

Raw snapshots preserve what a source returned at a point in time.

Examples:

- downloaded CSV;
- ATS JSON response;
- careers HTML;
- parsed feed payload;
- browser-rendered page.

They should be immutable and content-addressed where practical.

## 9.2 Observations

An Observation records what a source appeared to say about an entity or fact.

Examples:

```text
CompanyObservation
JobObservation
SignalObservation
```

Observation requirements:

- source ID;
- snapshot/artifact reference;
- external source identifier if available;
- observation time;
- parsed structured payload;
- parser/extractor version;
- model/prompt version when AI was used;
- warnings/errors;
- entity-resolution state;
- schema version.

Observations are immutable or append-only after creation, except for processing metadata/state.

Do not overwrite historical observation content.

---

# 10. Provenance and confidence

Every material canonical fact should be traceable to supporting evidence.

Shared reference primitive:

```text
EvidenceReference
  sourceId
  observationId?
  artifactId?
  locator/path/field?
  observedAt
  extractor/version metadata?
```

Confidence should support:

```text
level: high | medium | low | unknown
score?: 0..1
reasons[]
```

Do not create fake mathematical precision merely because a numeric score is possible.

Field-specific authority must be supported.

Example:

- UK government sponsor registry is authoritative for licence presence.
- Official ATS is stronger for exact current job requirements.
- Historical hiring evidence cannot be promoted to "this role sponsors".

---

# 11. Company domain

## 11.1 Canonical Company

The Company aggregate represents Aptamind's best current understanding of an employer entity.

Initial model should support:

### Identity

- display name;
- normalized name;
- aliases;
- official domain;
- official website;
- external/source identifiers.

### Classification

- industries;
- sub-industries;
- business model where confidently known;
- company stage/classification such as startup/scale-up/mid-market/enterprise;
- configurable values/classification seam (e.g. future Shariah methodology), with evidence and confidence.

### Firmographics

- founded year;
- employee estimate;
- employee range;
- funding stage;
- funding observations/summary where available.

### Geography

- headquarters;
- known offices;
- hiring regions/countries where supported by evidence.

### Employment

- careers URL(s);
- ATS/provider;
- remote-policy observations;
- sponsorship capability;
- relocation support;
- EOR/payroll indicators where available.

### Organization seam

Preserve future support for:

- founders;
- CEO;
- leadership;
- recruiting contacts;
- teams.

Full people enrichment is not required for the first milestone.

### Quality/freshness

- canonical status;
- merged/alias history;
- last refreshed;
- provenance summary;
- confidence/conflict summary;
- schema version.

## 11.2 Company entity resolution

Resolution should combine deterministic evidence before AI/fuzzy fallback.

Priority signals include:

1. exact official domain;
2. source/external canonical ID;
3. known alias;
4. normalized legal/display name;
5. website/domain similarity;
6. additional fuzzy/semantic evidence.

Results:

- exact/strong match;
- probable match;
- create new;
- review required.

Ambiguous merges must never be automatic above the configured risk threshold.

All merges should be auditable and reversible where practical.

---

# 12. Job domain

## 12.1 Canonical Job

Initial job aggregate should support:

### Identity

- original title;
- normalized title;
- role family;
- specialization;
- department/function;
- seniority;
- source requisition ID when available.

### Company

- canonical company ID.

### Description/content

- original description artifact/reference;
- extracted/plain text;
- structured derived intelligence.

### Employment

- employment type;
- contract/full-time/etc.;
- schedule/duration when available.

### Geography/work model

- listed location text;
- normalized locations;
- allowed countries/regions;
- excluded countries/regions;
- work model: remote/hybrid/onsite/unclear;
- remote scope: worldwide/region/country/selected countries/timezone/unclear;
- timezone constraints;
- office-attendance requirement.

### Immigration/employability

- explicit role sponsorship yes/no/unclear;
- company sponsorship capability evidence;
- existing authorization requirement;
- relocation support;
- confidence/provenance.

### Compensation

- minimum;
- maximum;
- currency;
- period;
- employment basis;
- equity/bonus text where available;
- original salary text;
- confidence.

### Requirements

Structured requirements with:

- source text;
- normalized concept;
- category;
- importance: critical/important/preferred/incidental;
- explicit vs inferred;
- evidence locator;
- confidence.

### Responsibilities/scope

Support structured interpretation for future matching:

- architecture;
- implementation;
- ownership;
- leadership;
- management;
- product collaboration;
- operational responsibility.

### Application

- canonical posting URL;
- apply URL;
- ATS/provider;
- source identifiers.

### Lifecycle

- first seen;
- last seen;
- last verified;
- published time when known;
- changed time;
- closed time;
- state.

Recommended states:

```text
DISCOVERED
VERIFIED_LIVE
CHANGED
POSSIBLY_STALE
CLOSED
REOPENED
REPOSTED
```

## 12.2 Job entity resolution

Use:

- canonical company;
- ATS/external requisition ID;
- canonical/application URL;
- title;
- location;
- description fingerprint;
- publish/first-seen timestamps;
- structured similarity.

Distinguish:

- exact duplicate;
- syndicated copy;
- same requisition/different location;
- repost;
- materially changed job;
- distinct job.

Ambiguity enters review.

---

# 13. Employment intelligence

This is a major product-quality requirement.

A boolean `remote` field is explicitly insufficient.

The Market stream must model what the job actually permits.

## 13.1 Evidence hierarchy

For role-specific employability facts, use an explicit hierarchy such as:

1. explicit job description statement;
2. application/ATS constraints;
3. official company employment policy;
4. company-level sponsorship/remote capability;
5. historical company hiring evidence;
6. inference.

This hierarchy can vary by field; do not force one universal authority ranking.

## 13.2 Required classifications

Support at minimum:

```text
workModel:
  remote | hybrid | onsite | unclear

remoteScope:
  worldwide | region | country | selected_countries | timezone | unclear

sponsorship:
  explicit_yes | explicit_no | company_capable | historical_evidence | unclear

relocation:
  explicit_yes | explicit_no | possible | unclear
```

`company_capable` must never be presented as `explicit_yes` for a specific job.

Unknown must remain unknown.

---

# 14. Signals

A Signal is a market event or observation that may indicate change/opportunity but is not necessarily a formal job.

Examples:

- funding event;
- hiring-intent post;
- team expansion;
- new office/geography;
- leadership change;
- careers-page spike;
- product launch;
- remote-policy change;
- job mention.

Initial Signal infrastructure should be supported by schema and workflow architecture, but broad social/community signal collection is not required for the first Market Foundation milestone.

Signal requirements:

- type;
- company/entity references;
- actor/person reference when relevant;
- source/provenance;
- raw evidence;
- occurred/observed timestamps;
- structured extracted facts;
- confidence;
- lifecycle/state.

A signal may trigger a workflow such as company refresh or careers discovery.

---

# 15. Reconciliation

Reconciliation decides what Aptamind currently believes.

It must be deterministic where possible and explicit where uncertain.

Inputs may include:

- competing source observations;
- source authority;
- recency/freshness;
- specificity;
- confidence;
- previous canonical fact;
- conflict policies.

Outputs:

- canonical value;
- evidence references;
- confidence;
- conflicting evidence;
- policy/version;
- review requirement.

Never delete contradictory observations merely because one wins canonically.

---

# 16. Freshness and verification

Different market facts decay at different rates.

Support configurable freshness policies per source/fact class.

Examples:

- active jobs: hours/daily;
- careers pages: daily;
- sponsor registries: on source update/daily check;
- company employee size: weekly/monthly;
- funding/stage: event/periodic;
- remote policy: periodic;
- people/leadership later: periodic.

Verification should update lifecycle/freshness without destroying history.

A job missing from one fetch should not instantly be considered closed if the source is unreliable or fetch failed.

Use a state/policy that can distinguish:

- source failure;
- item absent;
- item likely stale;
- item verified closed.

---

# 17. Review queue

Human review is a first-class reliability mechanism.

Create `ReviewItem` for material ambiguity such as:

- unresolved company identity;
- uncertain duplicate;
- conflicting work-model evidence;
- sponsorship conflict;
- parser/extractor failure;
- suspicious salary normalization;
- high-impact reconciliation below threshold.

Review actions:

- confirm;
- correct;
- merge;
- reject;
- retry/reprocess;
- dismiss with reason.

Review decisions should create audit history and be usable later as evaluation/training data.

---

# 18. Admin application

No auth.

Initial screens:

## Dashboard

- source health;
- workflows running/failed;
- jobs discovered/changed/closed;
- companies created/resolved;
- review backlog;
- freshness warnings;
- queue/worker health.

## Sources

- list/details;
- enable/disable;
- run now;
- schedule configuration;
- connector/capability config;
- last runs/failures;
- source authority/freshness metadata.

## Workflows

- definitions/versions;
- run now;
- inspect graph/config in readable form;
- run history;
- node run details.

A graphical drag/drop editor is out of scope initially.

## Companies

- canonical profile;
- supporting observations;
- conflicts;
- jobs;
- source provenance;
- refresh/research action.

## Jobs

- canonical job;
- original sources;
- lifecycle;
- employment intelligence;
- structured requirements;
- freshness/verification;
- rerun interpretation/verification.

## Review

- queue;
- evidence side-by-side;
- resolution actions;
- audit history.

---

# 19. API requirements

Use stable internal APIs rather than allowing UI code to reach database collections directly.

At minimum expose resource APIs for:

- health/readiness;
- sources;
- workflows;
- runs/node runs;
- companies;
- jobs;
- review items;
- manual run/reprocess/verify actions.

Future auth can wrap these APIs without changing core domain interfaces.

---

# 20. AI gateway

Do not wire domain modules directly to one model provider.

Create an AI gateway with task-oriented calls such as:

```text
structuredExtract
classify
reasonStructured
embed (optional seam)
```

Every AI-derived output must record:

- provider/model;
- model version/identifier;
- prompt/template version;
- input artifact/observation references;
- output schema version;
- token/cost metadata when available;
- latency;
- generated timestamp.

The first implementation may support one provider, but the calling domain must remain provider-neutral.

---

# 21. Taxonomy/ontology seam

Create first-class versioned taxonomies for fields that otherwise drift across prompts/sources.

Initial need includes:

- role families;
- seniority;
- employment types;
- work models;
- countries/regions/timezones;
- industries;
- company stages;
- requirement categories.

Do not attempt to solve every global taxonomy in v0.1. Establish versioning, normalization, and extension mechanisms.

---

# 22. Observability

Two distinct classes are required.

## 22.1 Engineering observability

- API latency/errors;
- worker errors;
- queue lag;
- workflow duration;
- node duration/failure;
- retries;
- Mongo/Redis/storage availability;
- crawler/browser failures;
- AI call latency/errors/cost.

Use structured logs with correlation IDs:

```text
requestId
workflowRunId
nodeRunId
sourceId
companyId/jobId when relevant
```

Add OpenTelemetry-compatible tracing/metrics seams.

## 22.2 Intelligence/data-quality observability

Track:

- duplicate/merge rate;
- unresolved entity rate;
- stale job rate;
- verification rate;
- observation-to-canonical lag;
- source error rate;
- source freshness;
- employment-intelligence confidence distribution;
- review backlog/age;
- correction rate.

These are product-quality metrics, not merely engineering metrics.

---

# 23. Security and data handling

Even without auth:

- no secrets in workflow JSON;
- use CredentialRef abstraction;
- local v0.1 credential resolution may map to environment variables;
- never log credentials;
- PII-sensitive logs must be minimized;
- raw artifacts private by default;
- use signed/private object access where relevant;
- network/crawler operations require SSRF protection;
- URL inputs must be validated;
- crawl scopes must enforce host/domain limits;
- HTML/content parsing must not execute untrusted page scripts except inside isolated browser context;
- arbitrary code/script execution is deferred until a real sandbox exists.

Because there is no auth, do not ship an internet-exposed admin deployment as part of this programme.

---

# 24. Reliability requirements

The system must be resilient to:

- worker termination;
- Redis restart;
- API restart;
- transient HTTP failure;
- source throttling;
- duplicate source payloads;
- partial workflow failure;
- parser failure;
- AI provider error;
- malformed records;
- repeated scheduled triggers.

Required characteristics:

- retry with bounded backoff;
- idempotent side effects;
- durable run state;
- dead-letter/failure visibility;
- restart/resume where safe;
- per-source rate limiting/concurrency;
- cancellation;
- timeouts;
- clear terminal states;
- deterministic reprocessing from saved raw snapshot where possible.

---

# 25. Testing and evaluation

## 25.1 Unit tests

Required for:

- normalization;
- entity resolution;
- reconciliation policies;
- lifecycle state transitions;
- workflow state transitions;
- idempotency keys;
- employment classification policies;
- capability input/output validation.

## 25.2 Integration tests

Test:

- Mongo persistence;
- BullMQ dispatch/retry;
- object storage;
- workflow execution across multiple nodes;
- worker crash/retry semantics;
- source -> observation -> canonical pipeline;
- review generation.

Use containers/local services where practical.

## 25.3 Fixtures/golden datasets

Create curated fixtures for:

- company duplicates/aliases;
- job duplicates/reposts;
- remote wording;
- sponsorship wording;
- salary formats;
- malformed source records;
- stale/closed jobs.

Do not evaluate extraction quality by ad-hoc visual inspection only.

## 25.4 Regression metadata

Derived intelligence should retain:

```text
schemaVersion
logicVersion
policyVersion
promptVersion?
modelVersion?
taxonomyVersion
computedAt
```

This permits controlled recomputation/regression analysis.

---

# 26. Initial proving workflow

The preferred first end-to-end real workflow is a **UK Sponsor Company Discovery** workflow because it exercises company-universe import, provenance, entity resolution, enrichment, careers discovery, and eventually job discovery.

Initial stages:

```text
Manual/Schedule Trigger
-> Download current sponsor dataset
-> Store Raw Artifact
-> Parse CSV
-> Map sponsor record -> CompanyCandidate
-> Resolve Company
-> Create Company Observation
-> Reconcile/Publish Company
```

Then extend:

```text
For newly/changed companies
-> Discover official website
-> Discover careers page
-> Detect ATS
-> Register discovered job source
-> Fetch jobs
-> Create Job Observations
-> Resolve Jobs
-> Interpret employment/location requirements
-> Verify
-> Publish canonical Jobs
```

Important semantic rule:

> Company appears in a sponsor registry means the company is capable/licensed to sponsor under the relevant scheme. It does not mean every role sponsors.

The domain model must preserve this distinction.

---

# 27. Initial ATS/careers support

Start with a deliberately narrow set:

- Greenhouse;
- Ashby;
- Lever;
- generic careers page/browser ingestion fallback.

Do not delay v0.1 to support every ATS.

Each provider-specific connector should translate into shared observations rather than leaking provider shape into canonical jobs.

---

# 28. Milestones

## F0 — Foundation

Deliver:

- monorepo;
- apps/admin, worker, admin;
- MongoDB/Redis/object storage local development stack;
- shared validation/config/logging/testing;
- health/readiness;
- CI;
- basic package boundaries.

## F1 — Execution Platform Core

Deliver:

- workflow definitions/versions;
- workflow runs/node runs;
- capability registry/SDK;
- manual trigger;
- schedule trigger;
- retry/timeout/idempotency;
- basic control/fan-out;
- artifacts;
- logs/run inspection;
- durable state in Mongo;
- BullMQ execution transport.

## M1 — Source + Company Core

Deliver:

- sources;
- raw snapshots;
- company observations;
- canonical company;
- company resolution;
- provenance/confidence;
- review items.

## M2 — First Real Company Workflow

Deliver:

- UK sponsor dataset workflow;
- repeatable ingestion;
- dedupe/entity resolution;
- reprocessing from snapshots;
- admin inspection/review.

## M3 — Careers/ATS Discovery + Jobs

Deliver:

- careers discovery;
- ATS detection;
- Greenhouse/Ashby/Lever connectors;
- job observations;
- canonical jobs;
- job resolution;
- job lifecycle.

## M4 — Employment Intelligence

Deliver:

- work-model extraction;
- remote scope;
- location constraints;
- sponsorship distinctions;
- relocation;
- salary normalization;
- structured requirements;
- provenance/confidence;
- review on material ambiguity.

## M5 — Operational Hardening

Deliver:

- source health;
- freshness policies;
- verification workflows;
- data-quality dashboards;
- failure/retry visibility;
- integration/golden tests;
- runbooks/documentation.

Signals beyond schema/seams and broad additional source expansion are follow-on work after the foundation proves reliable.

---

# 29. Explicit non-goals

Do not implement during this programme unless required to support the core architecture:

- user authentication;
- permissions/RBAC;
- subscriptions/billing;
- candidate profiles;
- matching;
- resume generation;
- candidate-facing feed;
- Chrome extension;
- outreach;
- portfolio builder;
- social-message automation;
- general plugin marketplace;
- public generic workflow product;
- full visual workflow canvas;
- Kafka;
- Temporal;
- Neo4j;
- ClickHouse/data warehouse;
- dedicated vector database;
- dedicated search cluster;
- Kubernetes requirement;
- microservices.

These may be introduced later only from demonstrated need.

---

# 30. Definition of Done for Market Foundation v0.1

The programme is not complete merely because the code compiles.

A successful Market Foundation demonstrates all of the following:

1. A source can be registered and triggered manually or on schedule.
2. A generic workflow executes through durable workflow/node-run state.
3. Fetch/download results can be preserved as raw artifacts.
4. Source data creates immutable observations rather than directly overwriting canonical entities.
5. Company entity resolution can reuse an existing company or create a new one, with review for ambiguity.
6. Canonical Company facts retain provenance/confidence.
7. The UK sponsor workflow can be rerun idempotently without duplicating companies/observations incorrectly.
8. Careers/ATS discovery can create reusable job sources.
9. At least Greenhouse, Ashby, and Lever can ingest job observations through provider adapters.
10. Canonical jobs can deduplicate source copies and preserve lifecycle history.
11. Job verification can distinguish live, potentially stale, and verified closed.
12. Work model/remote scope/location restrictions can represent more than a boolean remote value.
13. Company sponsor capability remains distinct from role-specific sponsorship.
14. Ambiguous/conflicting material data creates review items instead of fabricated certainty.
15. Admin can inspect sources, companies, jobs, workflow runs, errors, and review items.
16. Worker/API restarts and retries do not corrupt or duplicate canonical state.
17. Core policies have unit tests and end-to-end vertical slices have integration tests.
18. Golden fixtures exist for entity resolution, job lifecycle, remote/location, sponsorship, and salary normalization.
19. Every AI-assisted structured output is schema validated and version traceable.
20. Documentation explains how to add a new generic capability, Market capability, source connector, and workflow template.
21. No authentication code has been added.
22. No Professional or Opportunity domain dependency has been introduced.

---

# 31. Future compatibility

The foundation must make the following future workflows possible without redesigning the engine:

```text
Upload CV
-> Parse
-> Extract assertions
-> Request confirmation
```

```text
Connect code provider
-> discover repos
-> deep analysis capability
-> professional evidence
```

```text
Job + Profile
-> evidence mapping
-> fit
-> reachability
```

```text
Application submitted
-> wait
-> check response
-> follow-up
```

The Market build does not implement these. It proves the substrate can support them.

---

# 32. Final engineering principle

The difficult part of Aptamind Market Intelligence is not obtaining bytes from websites.

It is producing **trustworthy, explainable, fresh, reproducible intelligence from conflicting and changing information**.

Optimize architecture and engineering effort for that outcome.
