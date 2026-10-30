# Aptamind Market Foundation Package

This package contains the authoritative starting documents for the first Aptamind engineering programme.

## Build objective

Build a production-grade **Aptamind Foundation + Market Intelligence stream** with **no authentication** and no dependency on the future Professional Intelligence or Opportunity Intelligence streams.

The Market stream must prove two things simultaneously:

1. Aptamind can turn heterogeneous external sources into trustworthy, continuously refreshable Company, Job, and Signal intelligence.
2. The underlying Aptamind execution platform is generic enough to later run Professional, Opportunity, Application, repository-analysis, research, and agent workflows without redesigning the runtime.

## Files

1. `01_MARKET_CONTEXT_AND_REQUIREMENTS.md`
   - Architecture authority and product context.
   - Locked principles, domain boundaries, technical requirements, data model, workflow runtime, reliability requirements, package boundaries, and Definition of Done.
   - Treat this as the architecture and engineering context document.

2. `02_MARKET_PRD.md`
   - Product Requirements Document for Market Foundation v0.1 through Market Intelligence v0.1.
   - Defines actors, problems, workflows, functional requirements, milestones, success metrics, acceptance criteria, risks, and non-goals.

3. `03_CLAUDE_CODE_AUTONOMOUS_PROMPT.md`
   - Paste into Claude Code from the repository root.
   - Instructs Claude Code to bootstrap or extend the repository and execute the programme autonomously, milestone by milestone, without routine human intervention.

## Authority order

When executing the programme, use this authority order:

1. Explicit current owner instructions.
2. `01_MARKET_CONTEXT_AND_REQUIREMENTS.md`.
3. `02_MARKET_PRD.md`.
4. Existing repository architecture decision records that do not conflict with the above.
5. Locked milestone contract for the current unit of work.
6. Implementation details and local todo state.

Do not silently reconcile a conflict. Higher authority wins.

## Scope lock

### In scope

- Repository/monorepo foundation.
- MongoDB operational persistence.
- Redis + BullMQ asynchronous execution.
- S3-compatible object storage abstraction, with local MinIO-compatible development support.
- Generic workflow/execution platform.
- Capability/node registry and typed node contracts.
- Sources, raw snapshots, observations, provenance, confidence, reconciliation, entity resolution, companies, jobs, job lifecycle, employment intelligence, workflow runs, admin review, operational observability.
- Initial source workflows and ATS/careers ingestion.
- Internal admin UI/API with **no authentication**.

### Explicitly out of scope

- Authentication, authorization, billing, subscriptions.
- Professional Intelligence.
- Opportunity Intelligence / candidate-job matching.
- Resume generation.
- Candidate-facing job feed.
- Browser extension.
- Outreach.
- Portfolio builder.
- Candidate or employer agents.
- Marketplace.
- ATS product.
- Generic public automation product.
- Plugin marketplace.

## Important no-auth constraint

No authentication should be implemented in this programme. The code must nevertheless preserve an authentication/authorization seam so it can be added later without rewriting domain modules.

Until authentication exists, the admin application is an **internal/private operational surface** and must not be described or configured as safe for public internet exposure.
