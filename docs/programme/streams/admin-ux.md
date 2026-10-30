# Stream C — Admin UX redesign (Attio-grade)

Status: UX0 + UX1 implemented (`admin/ux0-foundations`, `admin/ux1-shell`), UX2 on `admin/ux2-primitives`, UX5 on `admin/ux5-facts`, UX3 (Jobs, Companies, Sources) on `admin/ux3-record-table`, UX3f (Review, Runs) on `admin/ux3f-review-runs` · Plan branch `admin/attio-redesign` (from Foundation `d9799b6`) · Contract: [`docs/design/admin-design-system.md`](../../design/admin-design-system.md)

Owner decision: the whole of `apps/admin` follows Attio's product-design philosophy (calm, dense,
record-oriented, keyboard-first, progressively disclosed). Attio is inspiration only: no copied
code, branding, assets or pixel layouts. Linear/Vercel/Railway inform run/observability views only.

Research note: attio.com could not be fetched from this environment (egress-blocked). Search
snippets of Attio's public help centre and changelog were used (views, ephemeral filters, record
preview, record pages, workflows run viewer, quick actions), together with prior product knowledge.

## 1. Current IA audit (Foundation `d9799b6`)

Stack: Next 16 / React 19, server components + server actions, `lib/api.ts` → internal API only
(`NEXT_PUBLIC_APP_URL`), one 1,035-line `globals.css` with custom-property tokens (light/dark), no UI
library, no icons, no tests (the vitest globs only match `apps/**/src/**`, which the admin lacks).
~9k lines: 18 pages (plus the artifact proxy route), 16 components, `lib/types.ts` (913 lines, hand-mirrored API types).

| Route                                                    | What it does                                                                                                                                                                                                                                           | Main UX problems                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` Dashboard                                            | 8 stat cards, failing/stale sources, run-state and queue tables, 3 distributions, a 9-chart data-quality block                                                                                                                                         | Dashboard bloat: ~20 equal-weight blocks, no "what needs me now" ordering; infra terms (BullMQ queue names, "mean attempts/node") on the home page; data-quality is a report, not a home                                                    |
| `/sources` `/sources/[id]` `/sources/new`                | List with filters; detail = health, schedule, origin, governance, runs, snapshots, upload, reviews, audit, JSON-patch edit; create = 28-line JSON textarea                                                                                             | 12 columns, name wraps to 4 lines, ids shown raw; config editing and creation are raw JSON; the enable/disable toggle sits next to "Run now"                                                                                                |
| `/workflows` `/workflows/[key]`                          | Definitions + schedules; detail = run form (JSON), schedules, every version's node list as nested cards                                                                                                                                                | The graph is a numbered list with `← after` text edges; all versions render expanded (latest) or collapsed; no definition vs run separation                                                                                                 |
| `/runs` `/runs/[id]` `/node-runs/[id]`                   | Filterable list; run detail = summary KV, input/output JSON, node cards (config/input/output/attempts/logs as `<details>`)                                                                                                                             | Engineering-console aesthetic; N+1 node-run fetches for logs; no timeline/durations view; no selected-node inspector; everything expanded in one long page                                                                                  |
| `/companies` `/companies/[id]`                           | List (8 cols); detail = quality, identity, ~20 `FactView`s each with evidence table + conflicts, licences, observations, jobs, job sources, reviews, audit                                                                                             | Detail is 3,400px of equal-weight sections; lower-authority alternates render as red "N conflicting values" while fact status is `known` and "Conflict fields: none" (alarm fatigue, contradicts itself); evidence tables inline everywhere |
| `/jobs` `/jobs/[id]`                                     | List with 7 filters; detail = 15 sections (identity, source copies, lifecycle, verification, work model, sponsorship, compensation, requirements, responsibilities, interpretation, conflicts, AI proposals, description, observations, reviews/audit) | Company column shows raw `cmp_…` ids although `/api/jobs` already returns `companyName`; list "Salary" shows parse status not salary; job page 4,200px desktop / 19,000px mobile                                                            |
| `/review` `/review/[id]`                                 | Queue (status/type filters); detail = item KV, resolve form, compare table, evidence, observations, audit                                                                                                                                              | No triage flow (open → decide → next); "correct" needs a hand-typed JSON value; context shown as raw JSON first; no claim/assign                                                                                                            |
| `/capabilities`                                          | Capability registry with schemas                                                                                                                                                                                                                       | Settings-level content in primary nav                                                                                                                                                                                                       |
| `/observations/[id]` `/snapshots/[id]` `/artifacts/[id]` | Provenance leaf pages; artifact proxy serves text/plain + sandbox CSP                                                                                                                                                                                  | Good safety; reachable only through tiny mono links                                                                                                                                                                                         |

Cross-cutting findings (screenshots of every route at 1440 and 390 px, taken against a seeded, isolated stack):

- **Shell:** permanent red "no authentication" banner shouts on every page; the sidebar's "API ready"
  box (URL + checks) is infra noise; no breadcrumbs, search, ⌘K or shortcuts; no skip link.
- **Lists:** no sort control (API sort is fixed per collection), no saved views, no column choice,
  no row preview; filters are a form with an Apply button; enum lists are hard-coded in pages
  (drift risk against Market enums); `limit/offset` + `countDocuments` on every page.
- **Detail:** no header hierarchy (id, status, conflicts, reviews all in one subtitle line), no
  tabs, provenance always expanded, debug JSON inline with business facts.
- **States:** loading is the text "Loading…"; empty states are italic lines; API errors are good
  (code, request id) and must be kept.
- **Responsive:** horizontal page scroll on Dashboard/Jobs/Job at 390 px; the sidebar stacks above content.
- **Payload:** `/api/jobs?limit=50` returns ~13 KB per job (full facts + evidence) for a table
  that needs ~10 scalars; `/api/companies` ~7 KB per row.
- **Worth keeping:** API error panel, server actions with inline results, artifact safety proxy,
  `RelTime` (relative + absolute), semantic tables with captions, `aria-current` nav, focus ring,
  dark mode tokens, "company licence ≠ role sponsors" copy.

## 2. Interaction principles (Attio → Aptamind)

1. **Records are the product.** Companies, Jobs, Sources, Review items, Runs (later Professional
   profiles) share one pattern: table → filters → sort → saved views → configurable properties →
   side-panel preview → full record page. One component set, driven by an object registry.
2. **The URL is the view.** Filters, sort, columns, density, selected tab and `?peek=` live in the
   URL (server-rendered, shareable, back-button safe). Changes are _ephemeral_ until saved as a
   view (Attio "Save as new view"); system views ship in code.
3. **Calm hierarchy.** Sidebar and chrome recede; content carries weight. Borders only where they
   separate; hairlines not boxes; no cards around tables; colour only for meaning.
4. **Dense, not cluttered.** 32 px rows, 13 px text, tabular numerals, single-line cells with
   truncation + tooltip; secondary info on hover/peek, not in extra columns.
5. **Progressive disclosure.** Value first → confidence/provenance on demand (popover) → full
   evidence in the Evidence tab → raw JSON/ids in Debug. Never hide existing capability, move it.
6. **Keyboard-first.** ⌘K for everything, `/` search, `g`+letter navigation, `j/k` rows, `Enter`
   preview, `Esc` closes the innermost layer. Every action reachable without a mouse.
7. **Contextual actions.** Primary action in the record header, the rest in a `…` menu and ⌘K;
   destructive actions confirm inline, no modal walls.
8. **Truth from the API.** Render canonical values and statuses exactly; `unknown` is displayed as
   Unknown (with reason), never inferred (e.g. no remote-from-location, no salary guessing). The
   UI computes presentation only (relative time, humanised enums).
9. **Operations speak product.** "Last refreshed 3h ago · failing since Tue" not "consecutiveFailures=4";
   queue names, attempts and node ids live in run/debug surfaces.
10. **Run mode ≠ definition mode.** Workflow canvases show structure; runs overlay status,
    duration, retries and the selected node's output (Attio run viewer, Vercel/Railway logs).

## 3. Key decisions

**Keep components in `apps/admin` — do not extract `packages/ui` now.** There is one consumer;
`scripts/check-architecture.ts` gives `@aptamind/admin` an empty allow-list and the ESLint admin
block forbids persistence imports — a UI package would need a new `ALLOWED` entry, Next
`transpilePackages`, cross-package CSS Modules and its own test project for zero reuse today.
Structure instead: `components/ui/*` (domain-free primitives, no `@/lib/api` imports — enforced by
an ESLint `no-restricted-imports` block in UX0) and `components/records/*` (object registry,
table, panel, property renderers). Extraction trigger: a second React app (e.g. a Professional
portal) needs the primitives → move `components/ui` verbatim to `packages/ui` with
`ALLOWED['@aptamind/ui'] = []`.

**Styling: plain CSS with design tokens + CSS Modules; no Tailwind.** The app already uses
custom-property tokens with a dark scheme. Next supports CSS Modules natively (zero new
dependencies, no PostCSS config, offline build intact). `styles/tokens.css` (primitives +
semantic tokens, light/dark, density) + `styles/base.css`, ordered by `@layer reset, tokens,
base, components, utilities`; each component owns `X.module.css` that may reference only
semantic tokens. `globals.css` shrinks milestone by milestone and is deleted in UX10.

**Interactivity without a UI kit.** Native `<dialog>`, the Popover API, `inert`, roving
tabindex and a small `useHotkeys` hook cover command menu, menus, panel and tooltips. Icons: a
vendored set of ~30 ISC-licensed Lucide SVGs in `components/ui/icons` (attributed). The only
candidate dependency is a graph layout/canvas for UX8 — decided there by ADR (default: custom
SVG layered layout; DAGs are < 40 nodes).

**Tests (no pixel snapshots).** UX0 adds a vitest `admin` project (`apps/admin/**/*.test.{ts,tsx}`;
`node` env for codecs/formatters, `happy-dom` + `@testing-library/react` dev deps for client
components) and `pnpm test:admin-e2e`: Playwright (`playwright-core`, already in the lockfile)
against api/worker/admin booted on a throwaway `t_admin_*` DB with `seed:dev --demo`, asserting
by role/name plus `@axe-core/playwright` (dev dep, added in UX2 with the primitive catalogue)
for a11y rules. The boot script isolates itself (own `MONGODB_DB`, `QUEUE_PREFIX`, `S3_BUCKET`,
ports) so parallel streams sharing Redis/Mongo are unaffected — the audit stack ran this way.

## 4. Milestones UX0–UX10 (PR DAG)

Every PR is small (< ~600 changed lines), keeps all existing functionality reachable, and
lands with tests of three kinds only: **C** component (render/interaction), **R** route smoke
(page renders with seeded data, key roles present, no console errors), **I** critical
interaction (keyboard/flow). Market API contracts `M*` and Professional `P*` are listed in §5.

```
UX0 ─► UX1 ─► UX2 ─┬─► UX3 ─► UX4 ─┐
                   ├─► UX5 ─────────┴─► UX6 ─┬─► UX7 ─────────┐
                   ├─► UX8  (also after UX5) └─► UX9b search ─┤
                   └─► UX9a ⌘K navigation ───────────────────►├─► UX10 (after UX6–UX9)
```

| #    | Goal                      | Scope (PRs)                                                                                                                                                                                                                                                                                                       | Acceptance                                                                                                  | Tests                                                | Needs                                               |
| ---- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| UX0  | Foundations               | a) `styles/tokens.css`+layers, map old vars to tokens (no visual change) b) test harness (vitest admin project, e2e boot script) c) ESLint boundary for `components/ui`                                                                                                                                           | `pnpm check` runs admin tests; e2e smoke visits all 18 pages green                                          | R all routes                                         | —                                                   |
| UX1  | App shell                 | a) sidebar: workspace header, grouped nav (Home, Review, Records, Automations, Settings), counts, collapse b) top bar: breadcrumbs + page actions slot; calm "Internal · no auth" chip replaces red banner; API health → footer dot + Settings page c) mobile drawer, skip link, theme (system/light/dark cookie) | No horizontal scroll at 390 px; nav reachable by keyboard; `aria-current` kept                              | C nav, R shell, I drawer/Esc                         | open review count (exists in `/api/dashboard`)      |
| UX2  | Primitives                | Button/IconButton, StatusPill, Tooltip, Menu, Popover, Dialog, Tabs, Kbd, Skeleton, EmptyState, ErrorState (wraps ApiError), PropertyList, Time, CopyButton, Toast (server-action results)                                                                                                                        | All primitives documented in a `/settings/ui` catalogue route (dev only); focus/labels verified             | C each; axe on catalogue                             | —                                                   |
| UX3  | Record table & views      | a) object registry + URL view codec b) `RecordTable` (sticky header, density, truncation, j/k, selection) c) filter chips + sort menu + view tabs (system views) d) adopt Jobs e) Companies, Sources f) Review, Runs                                                                                              | Sort/filter/view state round-trips via URL; ≤ 50 rows server-paginated; company names not ids               | C codec/table, I j/k + filter chip                   | **API-1, API-2, API-3, API-4, API-10**              |
| UX4  | Side-panel preview        | `?peek=<id>` panel for Jobs/Companies/Sources/Review: header, key properties, "n of N", ↑/↓, open full page                                                                                                                                                                                                       | Enter opens, Esc closes, focus returns to row; panel is SSR                                                 | I keyboard peek flow                                 | **API-2** (summary by id)                           |
| UX5  | Properties & provenance   | `FactProperty` (compact/full), ConfidenceIndicator, ProvenancePopover, OtherValues (neutral) vs Conflict (warning), Unknown-with-reason; replace `FactView`                                                                                                                                                       | Every material fact reaches source → observation → artifact in ≤ 2 clicks (FR-23); alternates no longer red | C per state (known/unknown/conflicting, no evidence) | none (current `Fact` shape)                         |
| UX6  | Record page template      | Header (identity, status, primary action, critical metadata, `…`) + tabs Overview · Evidence · Activity · Related · Debug as nested routes; apply to Company, Job, Source                                                                                                                                         | Job page first screen answers "what, where, sponsorship, salary, live?"; all old sections reachable         | R per tab; I tab keys                                | **API-5, API-6**                                    |
| UX7  | Review workspace          | Split inbox (queue + item), triage keys, compare view, typed decision composer (per-field editors), claim, "decide & next"                                                                                                                                                                                        | Decide an item with keyboard only; no JSON typing for enum corrections                                      | I triage flow; C composer                            | **API-9, API-10**                                   |
| UX8  | Workflows & runs          | a) runs list polish + run header/timeline (duration bars) b) node inspector panel (Input/Output/Logs/Attempts), retry/resume/cancel c) definition canvas (read-only) d) run overlay on canvas; ADR on layout                                                                                                      | Failed node found in one click; definition and run modes are separate routes/toggle                         | C canvas layout, I select node, R runs               | **API-7, API-11**                                   |
| UX9  | Command & search          | a) ⌘K navigation + contextual actions (after UX2) b) global record search (after UX6)                                                                                                                                                                                                                             | Every nav target and record action in ⌘K; `/` focuses search                                                | I palette flow                                       | **API-8** (b)                                       |
| UX10 | Home, settings, hardening | Home = attention inbox (review, failing/stale sources, failed runs); Data-quality report page; Settings (capabilities, schedules, system/queues); axe pass; delete `globals.css`/legacy                                                                                                                           | PRD §12 dashboard questions answered above the fold; zero serious/critical axe violations                   | R + axe all routes                                   | **API-1–API-4**; **API-P1** when Professional lands |

Deferred from UX3 (review, recorded): mobile two-line rows (lists stay tables that scroll inside
their region at < 768 px) and the searchable attribute picker for "+ Filter" (the filter panel
lists every API filter; revisit when a list has more than about 30 filters or with
`/api/meta/enums`).

ADM-1 (`/imports`, branch `admin/adm-1-imports`): imports list, type chooser, CSV wizard
(companies, ATS boards), snapshot import and import detail, built on `market-imports.md`. The
wizard reads the CSV in the browser and uploads only the mapped columns. The source page keeps
its raw upload under an "Advanced" disclosure. E2E smoke covers `/imports/new*`; `/imports` and
`/imports/[id]` join it once the imports API (OPS-1) is on main.

Professional profiles join as a registry entry + record-page config after UX6 (no bespoke pages),
gated on **API-P1**.

## 5. API asks (owned by the domain/platform streams, not Admin)

Supervisor ruling (Wave 1 review): ids are `API-*` (not `M*`, which are Market milestones).
Ownership — **Market**: API-1–API-5, API-9 and Market enums in API-10 (domain lists, detail
sub-resources, review claim/descriptors). **Supervisor platform lane** (additive, composition
layer; no frozen-package behaviour change): API-6 activity feed, API-7 node-run logs, API-8
search, API-10 endpoint shell, API-11 run filters. **Professional**: API-P1. **Deferred**: API-12
saved-view persistence — URL views + code-defined system views are sufficient for v0.1.

| Id     | Contract                                                                                                                                                                                   | Why                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| API-1  | `sort=<field>[,-field]` on `/api/{companies,jobs,sources,review,runs}`, whitelisted + indexed, `_id` tiebreak; unknown params → 400 (today silently ignored)                               | sortable columns                     |
| API-2  | `view=summary` (or `fields=`) list projection: scalar value + status + confidence per fact, no evidence; same shape from `GET /:id?view=summary`                                           | jobs list is ~13 KB/row; peek panel  |
| API-3  | Filters: multi-value (`state=A,B`), date ranges (`lastSeenAfter`, `changedAfter`), `hasOpenReview`, `sourceId` on jobs/companies, confidence level, search over title **and** company name | filter chips/system views            |
| API-4  | Keyset pagination (`after=<cursor>`) + `count=exact                                                                                                                                        | none`; keep offset for compatibility | `countDocuments` per page; deep pages |
| API-5  | Paginated sub-resources: `/api/companies/:id/{jobs,observations,sources,audit}`, `/api/jobs/:id/{observations,verifications,audit}`                                                        | detail tabs load independently       |
| API-6  | Activity feed `/api/activity?entityKind&entityId&cursor`: audit + lifecycle transitions + verifications + review decisions + runs, one ordered shape                                       | Activity tab                         |
| API-7  | Node-run logs `/api/node-runs/:id/logs?cursor` and log counts in run detail                                                                                                                | run page does N+1 node-run fetches   |
| API-8  | Unified search `/api/search?q&kinds&limit` (name/title/domain/key/id prefix)                                                                                                               | ⌘K                                   |
| API-9  | Review: claim/release/assign (ADR-0017), filters `severity,entityKind,claimed`, `correctable` field descriptors (type/enum) in `GET /api/review/:id`                                       | triage + typed editors               |
| API-10 | `/api/meta/enums` (job states, work models, remote scopes, sponsorship, review types, health…) with labels                                                                                 | stop hard-coding enums in admin      |
| API-11 | Runs list filters: time range, trigger kind, duration; run detail exposes per-node queue wait vs execution time                                                                            | run timeline                         |
| API-12 | Saved views `/api/views` (object, name, query, createdBy actor) — generic platform concern; until then views are URL links + code-defined system views                                     | team views                           |
| API-P1 | Professional profiles list/detail following API-1–API-5 and the `Fact` shape                                                                                                               | profiles object                      |

## 6. Risks & guardrails

- No functionality regression: each PR's R-test visits the pages it touches; Debug tabs keep raw
  JSON, ids, attempts, logs, artifacts until replacements are proven.
- Contracts land independently: the registry marks a column sortable/filterable only when the
  API supports it (API-1/API-3 flip flags, no UI rewrite); until API-2 the table requests `limit≤50`.
- UI never derives domain facts; all interpretation stays in Market (reviewed in PR template).
- Parallel streams: admin changes stay inside `apps/admin` (+ root vitest/eslint config in UX0);
  API asks go to Market as contracts above, never as admin-side workarounds.
