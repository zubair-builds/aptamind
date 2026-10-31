# Stream ownership

File ownership prevents parallel workers from editing the same code. When two streams conflict, the
owner below wins; the other stream's requirement moves into a contract.

## Frozen Foundation (no stream edits without a Foundation Exception)

`packages/contracts`, `config`, `db`, `queue`, `storage`, `net`, `observability`, `ai`,
`provenance`, `taxonomy`, `workflow-sdk`, `workflows`, `workflow-nodes`, `testing`,
`docker-compose.yml`, `infra/`.

## Domain streams

| Stream        | Owns                                                                                                                                                                                                                                                  | Must not edit                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Market        | `packages/market/**`; `apps/admin/lib/api-server/routes` Market route modules; Market docs (`docs/architecture/market-*`, `docs/product/market-*`, guides/runbooks it wrote); `docs/programme/streams/market.md`; `docs/programme/contracts/market-*` | `apps/admin` UI components, frozen packages, `packages/professional/**` |
| Professional  | `packages/professional/**`; `apps/admin/lib/api-server/routes` Professional route modules; Professional docs; `docs/programme/streams/professional.md`; `docs/programme/contracts/professional-*`                                                     | `apps/admin` UI components, frozen packages, `packages/market/**`       |
| Admin UX      | `apps/admin/**`; `packages/ui/**` if created; `docs/design/**`; `docs/programme/streams/admin-ux.md`                                                                                                                                                  | domain packages, API routes, frozen packages                            |
| Identity (A2) | `packages/identity/**`; ADR-0022; `docs/programme/foundation-exceptions/FE-5-user-actor-kind.md`                                                                                                                                                      | domain packages, frozen packages (except via approved FE)               |

## Composition layer (shared, additive-only)

`packages/platform`, `apps/admin/lib/api-server`, and `apps/worker` bootstraps, `scripts/check-architecture.ts`
(`DOMAIN` set and `ALLOWED` map), `scripts/check-app-deps.ts`, `eslint.config.js`, root
`package.json`, `pnpm-lock.yaml`, `.github/workflows/ci.yml`.

- A domain stream may make **additive** registrations here (register its package, services,
  capabilities, routes, collections, architecture allow-list entry, CI step for its integration
  tests). Anything that changes existing behaviour is a Foundation Exception.
- `pnpm-lock.yaml` conflicts are regenerated with `pnpm install`, never hand-merged.
- The supervisor arbitrates conflicts in this layer.

## Supervisor

`CLAUDE.md`, `docs/programme/**` (except each stream's own file and contracts), CI policy, review
and merge decisions, Foundation Exception approval.

## Admin ↔ domain contract rule

Domain streams own facts and APIs; Admin owns presentation. A domain stream that needs UI writes
`docs/programme/contracts/<domain>-<surface>.md` (endpoint/query, schema, states, actions, errors,
permission assumptions, provenance/confidence semantics). Admin implements it. The UI never derives
business facts (e.g. never infers `remote` from a location string).
