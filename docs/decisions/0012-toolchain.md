# ADR-0012: Toolchain versions and local infrastructure

- Status: Accepted
- Date: 2026-09-27 (amended during the F1 audit: Docker-first, no installer dependency)

## Context

The environment ships Node 22; tooling compatibility matters more than the newest majors.

## Decision

TypeScript 5.9 (typescript-eslint support), Vitest 5 with `unit`/`integration` projects, tsup bundles for api/worker, Next.js for admin, Fastify 5, MongoDB driver 7, BullMQ 5, Zod 4, pino. Local infrastructure via Docker Compose (`docker-compose.yml`, also used by CI) — the supported developer setup. `scripts/local-infra.sh` is an optional fallback that starts the same services from native binaries already present on the machine; the repository does not prescribe how such binaries are installed, and no package manager (conda/micromamba or otherwise) is part of the required toolchain. The S3 service is SeaweedFS (ADR-0014).

## Consequences

Upgrades (TypeScript 7 native compiler, BullMQ 6) are follow-on work.
