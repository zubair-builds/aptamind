# Aptamind Market Intelligence — Product Requirements Document

**Release family:** Foundation v0.1 / Market Intelligence v0.1  
**Primary user:** Internal Aptamind market operator/admin  
**External candidate UI:** Out of scope  
**Authentication:** Out of scope  

---

# 1. Product summary

Aptamind Market Intelligence is the internal data and intelligence system responsible for discovering, collecting, interpreting, reconciling, verifying, and maintaining a trustworthy representation of the job market.

It should support many acquisition methods — APIs, ATSs, RSS, CSV/XLSX, crawlers, browser automation, source-specific scripts/capabilities, government datasets, accelerators, VC portfolios, and future signal sources — without coupling the workflow engine to any one domain or source type.

The result is a continuously refreshable set of canonical:

- Companies;
- Jobs;
- Signals;
- employment constraints;
- provenance;
- freshness;
- confidence;
- conflicts/review state.

The Market system is the supply-side foundation that a future Opportunity Intelligence layer will use to evaluate jobs for individual professionals.

---

# 2. Problem statement

Existing job data is noisy and unreliable:

- the same company appears under multiple names/domains;
- the same job appears on many boards;
- jobs remain visible after closure;
- "Remote" frequently hides country/timezone restrictions;
- sponsorship information is missing, stale, or incorrectly inferred;
- company remote and hiring policies differ from role-specific constraints;
- salary text is inconsistent;
- third-party sources conflict with official sources;
- signals may indicate hiring before formal roles appear;
- different ingestion mechanisms require different engineering paths;
- naive scrapers overwrite data without preserving why a fact was believed.

Aptamind needs a system that does not merely aggregate postings, but maintains a **reliable market model** with evidence and operational quality.

---

# 3. Product goals

## G1 — Trustworthy canonical market data

Maintain canonical Companies and Jobs with source provenance, confidence, and conflict visibility.

## G2 — Continuously current job state

Know when jobs first appear, change, disappear, close, reopen, or are reposted.

## G3 — Real employment intelligence

Represent remote scope, allowed locations, sponsorship, work authorization, relocation, salary, and other employment constraints as structured evidence-backed data rather than shallow tags.

## G4 — Flexible acquisition

Support new sources and acquisition strategies without redesigning the execution engine.

## G5 — Reusable Aptamind execution substrate

Market workflows must prove a generic execution platform reusable by later Professional, Opportunity, Application, and Agent workflows.

## G6 — Operational transparency

Operators must be able to see what ran, what failed, what changed, why a canonical value exists, and what requires review.

## G7 — Safe automation

Automation should handle high-confidence cases and escalate meaningful ambiguity rather than silently guessing.

---

# 4. Non-goals

This release does not provide:

- authentication;
- public-facing admin security;
- candidate profiles;
- candidate matching;
- recommendation feeds;
- resumes/cover letters;
- browser extension;
- outreach;
- portfolio generation;
- autonomous applications;
- employer ATS;
- marketplace;
- full visual n8n-style editor;
- hundreds of integrations.

---

# 5. Primary actor

## Internal Market Operator

Needs to:

- register/manage sources;
- ingest company universes;
- inspect discovered companies;
- ingest and verify jobs;
- understand source health/freshness;
- resolve ambiguity;
- review conflicts;
- run/retry workflows;
- understand failures;
- improve data quality.

This actor is internal. There is no authentication in v0.1.

---

# 6. Secondary system consumers

Future consumers, not implemented now:

- Opportunity Intelligence;
- Candidate Experience;
- Application Preparation;
- Outreach Strategy;
- Market analytics;
- Agentic execution.

The Market API/contracts should be designed so future consumers do not depend on source-specific shapes.

---

# 7. Core product concepts

## Source

A durable information origin plus configuration, acquisition capability, schedule, authority, and health metadata.

## Raw Snapshot

Immutable raw content returned by a source at a particular time.

## Observation

Structured statement parsed/extracted from a source snapshot.

## Canonical Entity

Aptamind's current best representation of a Company, Job, or Signal.

## Workflow

Versioned orchestration graph describing how capabilities execute.

## Capability/Node

Typed executable unit ranging from generic primitives to sophisticated domain operations.

## Review Item

Material uncertainty/conflict requiring human decision.

## Provenance

Trace from canonical fact to the sources/observations/artifacts that support it.

---

# 8. Key workflows

## WF1 — Company universe import

Example: UK licensed sponsor dataset.

```text
Trigger
-> Fetch/Download
-> Store Snapshot
-> Parse Dataset
-> Map rows
-> Resolve Company
-> Create Observation
-> Reconcile Company
-> Publish/Update Company
-> Review ambiguity
```

Expected outcome:

- repeatable idempotent ingestion;
- no uncontrolled duplicates;
- evidence retained;
- sponsor capability attached to company, not incorrectly projected to each job.

## WF2 — Careers discovery

```text
Company
-> find official website if missing
-> find careers URL
-> detect ATS/provider
-> register discovered job source
```

## WF3 — ATS job refresh

```text
Schedule
-> fetch ATS jobs
-> store snapshot
-> parse jobs
-> create Job Observations
-> resolve/dedupe Jobs
-> reconcile
-> update lifecycle
```

## WF4 — Generic careers crawl

```text
Schedule
-> browser fetch/crawl within scoped host
-> discover job links
-> fetch job pages
-> structured extract
-> create observations
-> resolve/reconcile
```

## WF5 — Job interpretation

```text
Job Observation
-> normalize title/role
-> extract requirements
-> classify importance
-> extract work model/location constraints
-> derive sponsorship/relocation evidence
-> normalize salary
-> validate
-> reconcile into canonical job intelligence
```

## WF6 — Job verification

```text
Job due for verification
-> check authoritative source/apply URL
-> compare source state
-> mark verified live / possibly stale / closed
-> retain verification evidence
```

## WF7 — Review resolution

```text
Review Item
-> operator inspects competing evidence
-> confirm/correct/merge/reject/retry
-> canonical state updated
-> audit event written
```

---

# 9. Functional requirements

## FR-1 Workflow engine

The platform shall provide versioned workflows and durable run state.

Acceptance:

- workflow definition can be created programmatically/configuration-first;
- executing a workflow creates a WorkflowRun;
- every node creates NodeRun state;
- failed node retains error/attempt information;
- retry does not lose history;
- historical runs reference immutable workflow/node versions.

## FR-2 Capability registry

The platform shall register typed capabilities with input/output/config schemas.

Acceptance:

- invalid node configuration is rejected before execution;
- invalid input/output is visible as execution error;
- node version recorded on run;
- domain capability can be added without changing workflow runtime.

## FR-3 Manual and scheduled triggers

Acceptance:

- workflow can be triggered manually;
- workflow can be scheduled;
- duplicate schedule dispatch does not corrupt canonical state;
- schedule state observable.

## FR-4 Fan-out and bounded concurrency

Acceptance:

- parsed collection can fan out into entity processing;
- max parallelism configurable;
- thousands of records do not create unbounded simultaneous tasks;
- aggregate workflow run remains observable.

## FR-5 Retry/timeout/cancellation

Acceptance:

- transient HTTP error retries with bounded backoff;
- terminal errors do not retry forever;
- timeout creates clear failure state;
- run/node can be cancelled;
- safe step can be retried.

## FR-6 Artifact storage

Acceptance:

- downloaded files/pages can be saved to object storage;
- ArtifactRef stores hash/type/size/key;
- reprocessing can use existing snapshot without refetching;
- large payload not duplicated through every workflow state document.

## FR-7 Source management

Acceptance:

- operator can create/enable/disable source;
- source records acquisition configuration/capability;
- source exposes last attempt/success/failure;
- source has freshness/schedule metadata;
- run can be launched from source detail.

## FR-8 Observations

Acceptance:

- source data creates observation documents;
- canonical entities reference supporting observations;
- observation keeps source/snapshot/version metadata;
- observation history survives later canonical changes.

## FR-9 Company resolution

Acceptance:

- exact-domain matches reuse canonical company;
- aliases/external IDs supported;
- ambiguous candidates create review rather than unsafe merge;
- merge action is audited;
- repeated imports are idempotent.

## FR-10 Canonical Company

Acceptance:

- supports identity, classification, firmographics, geography, employment, provenance/freshness;
- individual facts can retain evidence/confidence;
- company sponsor capability can be represented independently of role-specific sponsorship.

## FR-11 Careers discovery

Acceptance:

- company can be processed for careers URL;
- ATS/provider can be detected where possible;
- discovered job source can be registered and linked to company;
- ambiguity/failure visible.

## FR-12 ATS connectors

Initial required providers:

- Greenhouse;
- Ashby;
- Lever.

Acceptance:

- provider payload is converted into shared JobObservation contract;
- provider-specific shape does not leak into canonical job schema;
- source external IDs retained.

## FR-13 Generic careers fallback

Acceptance:

- browser/crawler can be scoped to allowed host/domain;
- extracted jobs produce JobObservations;
- crawl limits and timeouts exist;
- source failure does not mark all jobs closed automatically.

## FR-14 Job resolution

Acceptance:

- exact source/requisition matches reused;
- syndicated duplicates can resolve to one canonical job;
- repost/different-location cases can remain distinct when appropriate;
- uncertainty reviewable.

## FR-15 Job lifecycle

Acceptance:

- firstSeen/lastSeen/lastVerified tracked;
- job can move through discovered/live/changed/stale/closed/reopened/reposted states;
- transient source failure does not equal closed;
- lifecycle transitions tested.

## FR-16 Employment intelligence

Acceptance:

- work model is not a single boolean;
- remote scope supports worldwide/region/country/selected countries/timezone/unclear;
- explicit location restrictions override generic "remote" labels;
- sponsorship status distinguishes role explicitness from company capability/history;
- original evidence retained;
- unknown remains unknown.

## FR-17 Salary normalization

Acceptance:

- structured min/max/currency/period can be derived where possible;
- original salary text retained;
- malformed/ambiguous salary can remain unknown or generate review;
- no missing salary becomes zero.

## FR-18 Requirement extraction

Acceptance:

- job requirements can be represented as critical/important/preferred/incidental;
- original text/evidence locator retained;
- AI output validated before persistence;
- deterministic downstream consumers need not parse raw prose again.

## FR-19 Verification

Acceptance:

- job can be rechecked against authoritative source;
- verification status/evidence recorded;
- closed determination requires explicit policy, not one failed fetch;
- verification can be scheduled based on freshness.

## FR-20 Review queue

Acceptance:

- review items list type/severity/entity/reason/evidence;
- operator can resolve with action/reason;
- action updates domain state appropriately;
- review decision audited.

## FR-21 Admin operational UI

Acceptance:

- Dashboard, Sources, Workflows/Runs, Companies, Jobs, Review pages exist;
- no authentication;
- UI uses API rather than database direct access;
- operational failures and uncertainty are visible.

## FR-22 AI gateway

Acceptance:

- domain code invokes provider-neutral AI interface;
- structured-output schemas enforced;
- provider/model/prompt version recorded;
- AI failures can retry/fail without corrupting canonical state.

## FR-23 Provenance

Acceptance:

- operator can navigate from canonical job/company fact to supporting source/observation/artifact for material fields;
- source authority/conflict can be inspected.

## FR-24 Freshness

Acceptance:

- sources/facts can declare refresh policy;
- overdue/stale data visible;
- refresh workflow can be triggered;
- freshness differs by data class rather than one global interval.

## FR-25 Observability

Acceptance:

- structured logs have correlation/run IDs;
- workflow/node durations/failures visible;
- queue lag/retry visible;
- data-quality metrics available at least through internal endpoints/admin summaries.

---

# 10. Initial generic node set

The first version should provide only nodes required by the real workflows.

Recommended:

```text
Manual Trigger
Schedule Trigger
HTTP Request / Download
Browser Fetch
Browser Crawl (bounded)
Parse CSV
Parse JSON
Map Fields
Filter
For Each / Map
If / Switch
Structured AI Extract
Store Artifact
Load Artifact
Execute Subworkflow
```

Domain capabilities are registered through the same runtime contract.

No arbitrary unsandboxed code node in v0.1.

---

# 11. Market domain capability set

Initial capabilities:

```text
Create Company Observation
Resolve Company
Reconcile Company
Discover Careers
Detect ATS
Create/Register Job Source
Create Job Observation
Resolve Job
Interpret Job
Reconcile Job
Determine Employment Intelligence
Verify Job
Create Review Item
```

Some may be implemented as domain services; some may be reusable subworkflows. The workflow runtime should not care.

---

# 12. Admin experience requirements

## Dashboard

Must answer:

- Are sources healthy?
- What failed?
- How many companies/jobs changed?
- What is stale?
- What needs review?
- Are queues/runs backing up?

## Source detail

Must show:

- origin/configuration;
- acquisition capability;
- schedule/freshness;
- health;
- run history;
- errors;
- authority metadata;
- run now/disable.

## Workflow run detail

Must show:

- workflow version;
- start/end/status;
- node graph/list;
- node inputs/outputs summarized;
- attempts;
- logs/errors;
- artifacts;
- child/fan-out statistics.

## Company detail

Must show:

- canonical data;
- observations/sources;
- jobs;
- conflicts;
- freshness;
- provenance;
- review state.

## Job detail

Must show:

- canonical identity/content;
- company;
- source copies/observations;
- lifecycle;
- work model/remote scope;
- sponsorship/relocation;
- salary;
- requirements;
- verification/freshness;
- conflicts/provenance.

---

# 13. First vertical product slice

The first real slice should prove an end-to-end Market loop with real data.

## Slice A — UK sponsor universe

Input:

- UK sponsor dataset.

Output:

- canonical companies;
- sponsor capability observation/evidence;
- no duplicate explosion;
- admin review for ambiguous company resolution.

## Slice B — careers/ATS discovery

For a manageable subset of discovered companies:

- official domain;
- careers URL;
- ATS detection;
- source registration.

## Slice C — jobs

Fetch jobs from at least:

- Greenhouse;
- Ashby;
- Lever.

Produce canonical jobs with lifecycle.

## Slice D — employment intelligence

For sampled jobs:

- classify work model;
- normalize remote scope;
- identify location restrictions;
- represent sponsorship evidence correctly;
- normalize salary where possible;
- extract structured requirements.

---

# 14. Milestone acceptance gates

## Gate F0 — Foundation

Pass only if:

- local stack boots with one command;
- API/worker/admin run;
- Mongo/Redis/object storage available;
- CI/typecheck/lint/test work;
- environment validation/documentation exists.

## Gate F1 — Execution runtime

Pass only if:

- versioned workflow runs;
- node run state durable;
- retries/idempotency proven by tests;
- fan-out bounded;
- raw artifact can be stored/reloaded;
- run visible in admin/API.

## Gate M1 — Companies

Pass only if:

- real source -> snapshot -> observations -> canonical companies works;
- repeated run remains idempotent;
- ambiguous company is reviewable;
- provenance inspectable.

## Gate M2 — Jobs

Pass only if:

- careers/ATS source can be registered;
- provider jobs become observations;
- duplicates resolve;
- lifecycle tracks live/change/close safely.

## Gate M3 — Employment intelligence

Pass only if curated fixtures prove:

- `Remote` with embedded country restriction is interpreted correctly;
- company sponsor licence does not become job sponsorship yes;
- explicit `no sponsorship` wins;
- unknown stays unknown;
- evidence/confidence visible.

## Gate M4 — Operational reliability

Pass only if:

- worker restart does not lose run state;
- retry does not duplicate canonical entities;
- source failure does not mass-close jobs;
- review/backlog/failure metrics visible;
- golden regression suite runs.

---

# 15. Success metrics

Initial internal metrics:

## Source health

- successful run rate;
- median freshness lag;
- parser/crawler failure rate;
- source retry rate.

## Entity quality

- unresolved company rate;
- duplicate company rate;
- duplicate job rate;
- manual correction rate.

## Job quality

- verified-live percentage;
- stale-job percentage;
- closed-job confirmation lag;
- canonical source coverage.

## Intelligence quality

- remote-scope classification accuracy on golden set;
- sponsorship classification precision on golden set;
- salary normalization accuracy;
- requirement importance accuracy/correction rate.

## Operations

- review backlog;
- median review age;
- workflow/node failure rate;
- mean retry count;
- time to reprocess from snapshot.

Do not optimize for total job count yet.

---

# 16. Risks and mitigations

## Risk: building a generic automation product instead of Aptamind

Mitigation:

- only implement workflow features required by current Market workloads;
- no public plugin marketplace;
- no generic SaaS positioning;
- no visual canvas until real workflow patterns exist.

## Risk: schema drift in MongoDB

Mitigation:

- runtime validation;
- schema versioning;
- DB validation where practical;
- migration tooling;
- indexes reviewed explicitly.

## Risk: AI inconsistency

Mitigation:

- structured outputs;
- domain policy after extraction;
- prompt/model/version tracking;
- golden fixtures;
- review low-confidence material facts.

## Risk: source outages cause bad canonical state

Mitigation:

- distinguish fetch failure from item absence;
- multi-step close verification;
- preserve prior state;
- source health.

## Risk: crawling becomes unsafe/unbounded

Mitigation:

- host allowlists/scopes;
- URL validation/SSRF protection;
- page/depth limits;
- rate/concurrency limits;
- robots/terms/source governance metadata.

## Risk: user expects auth/security

Mitigation:

- explicitly internal/private admin only;
- no claim of public deployment readiness until auth exists;
- preserve future request-context seam.

---

# 17. Release outcome

At the end of Market Intelligence v0.1, Aptamind should be able to say:

> We can connect a new source, run a durable workflow, preserve what the source returned, convert it into immutable observations, resolve companies/jobs, reconcile facts, maintain job lifecycle and employment constraints, expose exactly why a fact is believed, and ask for human review where we are not confident.

That is the product milestone.

The number of supported sources is secondary.
