# Aptamind Admin — design system contract

Status: v1 (Stream C, UX0–UX10) · Plan: [`docs/programme/streams/admin-ux.md`](../programme/streams/admin-ux.md)

This is the contract every admin PR is reviewed against. The admin is a calm, dense,
record-oriented, keyboard-first tool. We take inspiration from Attio's interaction philosophy (and
Linear/Vercel/Railway for run observability) and do not copy its code, brand, icons or layouts.

**Non-negotiables**

1. Render canonical API values; never infer domain truth (no remote-from-location, no salary or
   sponsorship guesses, no client-side reconciliation). Unknown is shown as _Unknown_.
2. Colour is never the only signal: every pill/indicator has text or an accessible name.
3. Component CSS uses semantic tokens only (no hex, no raw px outside the spacing scale).
4. Existing capability (debug data, run inspection, review actions, provenance) is moved, never dropped.

## 1. Tokens

Files: `apps/admin/styles/tokens.css` (semantic tokens; declares the layer order), then
per-component `*.module.css` (rules inside `@layer components`). Cascade: `@layer reset, tokens,
base, components, utilities;` — every `*.module.css` repeats this statement on its first line, so
the order holds whichever stylesheet loads first. There is no separate `base.css` yet: the legacy
`app/globals.css` is the `base` layer (imported by `styles/index.css`) and is split into
`styles/base.css` (element defaults) plus modules as it shrinks, then deleted in UX10. Colours are `light-dark(light, dark)` pairs resolved by
`color-scheme`: `light dark` follows the OS (default, no script needed), `<html data-theme="light|dark">`
pins it from a cookie rendered server-side, so there is no flash.

UX0 kept the pre-redesign colour values behind these token names (no visual change); UX1 switched
them to the values below. Additional tokens: `--bg-hover` (6 % `--text` mix; hover on subtle
surfaces), `--scrim` (drawer backdrop), `--chart-bar` (distribution bars), `--text-*-lh`
(line heights), `--weight-{regular,medium,semibold}`, sizing (`--row-compact/-comfortable`,
`--control`, `--control-sm`, `--hit-min`, `--sidebar-width`, `--sidebar-collapsed-width`,
`--drawer-width`, `--topbar-height`, `--panel-width`, `--dialog-width`, `--popover-min/max-width`,
`--tooltip-max-width`, `--toast-max-width`, `--property-label-width`, `--content-max-width`) and
`--z-*` (stacking).

### Colour (semantic tokens; primitives are private to `tokens.css`)

| Token              | Light     | Dark      | Use                                                               |
| ------------------ | --------- | --------- | ----------------------------------------------------------------- |
| `--bg-app`         | `#fbfbfa` | `#111110` | page background                                                   |
| `--bg-surface`     | `#ffffff` | `#181817` | tables, panels, record page                                       |
| `--bg-subtle`      | `#f5f5f3` | `#1f1f1d` | sidebar, table header, hover                                      |
| `--bg-selected`    | `#eef1fd` | `#1d2440` | selected row / nav item                                           |
| `--border-subtle`  | `#ececea` | `#262624` | row separators                                                    |
| `--border`         | `#e0e0dc` | `#2f2f2c` | inputs, panel edges                                               |
| `--border-strong`  | `#c9c9c4` | `#3d3d3a` | dividers that must read, disabled control edges                   |
| `--border-control` | `#8a8a84` | `#72726c` | input/select/checkbox boundaries (≥ 3:1, WCAG 1.4.11)             |
| `--text`           | `#1b1b19` | `#ececea` | primary text                                                      |
| `--text-secondary` | `#5f5f5a` | `#a8a8a2` | labels, metadata                                                  |
| `--text-tertiary`  | `#6e6e68` | `#8b8b85` | placeholders, empty "—" (≥ 4.5:1 on every surface incl. selected) |
| `--accent`         | `#3b5bdb` | `#7c9aff` | primary buttons, links, selection bar                             |
| `--accent-fg`      | `#ffffff` | `#0d1330` | text on accent                                                    |
| `--focus-ring`     | `#3b5bdb` | `#9db2ff` | 2 px outline, 2 px offset                                         |

Status tones, each as `--tone-X-bg / -fg / -dot` (fg ≥ 4.5:1 on its bg):

| Tone      | Light fg / bg         | Dark fg / bg          | Meaning                                                   |
| --------- | --------------------- | --------------------- | --------------------------------------------------------- |
| `neutral` | `#5f5f5a` / `#f0f0ee` | `#b5b5ae` / `#262624` | inactive, closed, skipped, unknown                        |
| `info`    | `#1f5fbf` / `#e8f0fc` | `#8ab4ff` / `#16243b` | running, discovered, in progress                          |
| `success` | `#1a7f37` / `#e9f6ec` | `#6fd08c` / `#15291b` | healthy, live, completed, known                           |
| `warning` | `#8a5a00` / `#fff4d6` | `#f2c35b` / `#332812` | stale, degraded, open review, low confidence, conflicting |
| `danger`  | `#b42318` / `#fdecea` | `#ff8f87` / `#3a1a18` | failed, failing, explicit "no" that blocks                |
| `accent`  | `#6e3fc9` / `#f1ebfc` | `#c1a4ff` / `#271d3d` | changed, reposted (notable, not bad)                      |

Rules: one tone map (`lib/tones.ts`, from today's `Badge.tsx` map) keyed by enum value; danger is
reserved for failures that need action; "lower-authority alternate values" are **neutral**, not danger.

### Type

System stack only (offline build): `--font-sans: system-ui, -apple-system, "Segoe UI", Roboto,
"Helvetica Neue", Arial, sans-serif`; `--font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas,
"Liberation Mono", monospace`. Numbers in tables/metrics use `font-variant-numeric: tabular-nums`.

| Token              | Size / line | Weight  | Use                                 |
| ------------------ | ----------- | ------- | ----------------------------------- |
| `--text-xs`        | 11 / 16     | 500     | pill text, kbd, counters            |
| `--text-sm`        | 12 / 16     | 400     | metadata, table secondary, mono ids |
| `--text-md` (base) | 13 / 20     | 400     | body, table cells, properties       |
| `--text-lg`        | 14 / 20     | 500–600 | section headings, panel titles      |
| `--text-xl`        | 16 / 24     | 600     | page titles on lists                |
| `--text-2xl`       | 20 / 28     | 600     | record name (h1 on record pages)    |

Weights: 400 / 500 / 600 only. No uppercase labels except `kbd`. Sentence case everywhere.

### Spacing, radius, elevation, density, motion

- Spacing (`--space-N`, N in px, 4 px grid): 0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48.
- Radius: `--radius-sm` 4 (pills inner, kbd), `--radius` 6 (controls), `--radius-lg` 8 (popovers,
  panels), `--radius-xl` 12 (dialogs, ⌘K), `--radius-full` (pills, avatars).
- Elevation: `0` flat (default; separation by hairlines, not boxes); `1` `--shadow-popover`
  (menus, tooltips); `2` `--shadow-overlay` (panel overlay, dialog). Dark mode: lighter surface +
  `--border` instead of heavier shadows.
- Density (`data-density` on the table root): `compact` row 32 px (default), `comfortable` 40 px.
  Controls: 28 px (toolbar), 32 px (forms). Hit targets ≥ 24×24 px (WCAG 2.2 AA).
- Motion: `--dur-fast` 120 ms, `--dur` 180 ms, `--ease` cubic-bezier(.2,.8,.2,1). Only opacity and
  transform. `@media (prefers-reduced-motion: reduce)` sets durations to 0.
- Z-index: sidebar 10 · sticky headers 20 · side panel 30 · popover 40 · dialog/⌘K 50 · toast 60.
- Breakpoints: `≥1280` desktop (sidebar + content + optional panel) · `1024–1279` laptop (sidebar
  collapsible to 52 px) · `768–1023` tablet (sidebar drawer, panel overlays content) · `<768`
  mobile (inspection-first: lists become two-line rows, peek is a full-screen route).

## 2. Shell

```
┌ sidebar 232 ┬ top bar 44: breadcrumbs ……………………… page actions ┐
│ workspace   ├ view bar 40: view tabs · Filter · Sort · Display · count ┤
│ ⌘K  / search│ content (list or record page)          │ side panel 440 │
│ Home        │                                         │ (peek)         │
│ Review  12  │                                         │                │
│ Records ▾   │                                         │                │
│ Automations │                                         │                │
│ ─────────── │                                         │                │
│ Settings ●  │                                         │                │
└─────────────┴─────────────────────────────────────────┴────────────────┘
```

- **Sidebar** (`--bg-subtle`, recedes): workspace header "Aptamind · Market" (domain switcher when
  Professional lands) + collapse toggle. Quick row: Search `/`, Command `⌘K`. Groups: **Home**; **Review** (open count);
  **Records** — Companies, Jobs, Sources (Professionals later); **Automations** — Workflows, Runs;
  **Favorites** — pinned views (UX3+). Footer: Settings (Capabilities, Schedules, System status)
  with a single health dot (green/amber/red, accessible name "API ready"; the state is also spelled
  out as text when not ready), then the theme switch (System / Light / Dark radio group, cookie).
  Items 28 px, icon 16 px, active = `--bg-selected` + `--text`. The only count is Review's open
  items (warning tone; one `limit=1` request, 3 s timeout; hidden when zero) — record totals are
  noise. Root is `<aside aria-label="Sidebar">`. Collapsible to a 52 px rail (`[`, cookie): the
  workspace logo becomes the expand control, labels are visually hidden, Review keeps an attention
  dot and System status its health dot. Below 1024 px the sidebar is a drawer: menu button, scrim,
  `role="dialog" aria-modal="true" aria-label="Navigation"` while open with the page, top bar and
  skip link inert; `Esc` or `[` closes it and returns focus to the menu button; a navigation
  closes it and focuses `main`. Single-key shortcuts skip repeats, handled events, text
  boxes/comboboxes/contenteditable and open modal dialogs.
- **Top bar**: breadcrumbs `Object › Record › Tab` (≤ 3, derived from the URL; record crumbs show the
  id until record headers land in UX6; no `← Back` links in page subtitles — the breadcrumbs are
  the way up); right: page actions (primary button + `…`) from the `app/@actions/<route>`
  parallel-route slot wrapped in `PageActions`. Rule: the top-bar slot holds **object/list-level**
  actions only (e.g. New source); actions on one record (Run now, Verify, Retry) belong in the
  record header (UX6) and stay in the page until then. After the actions comes the calm
  `Internal · no auth` chip (replaces the red banner; links to Settings › System status › Access,
  which explains ADR-0008). The chip lives in the top bar so it is visible at every width and
  with the sidebar collapsed or closed. A shell-level callout appears under the top bar while the
  API is unavailable or not ready.
- **View bar** (lists only): system/saved view tabs, then `Filter`, `Sort`, `Display` (columns,
  density), result count. Ephemeral changes show `Unsaved · Reset · Save view · Copy link`.
- **Command menu (⌘K / Ctrl K)**: native `<dialog>`, 640 px, top 20 vh. Input + groups:
  _Actions for this page_ (contextual, e.g. "Verify job", "Run source now"), _Go to_, _Records_
  (search, UX9b), _Recent_. Fuzzy match, ↑/↓, Enter runs, ⌘Enter opens in new tab, shortcut
  hints right-aligned in `kbd`. Destructive commands open their inline confirmation.
- **Toasts**: bottom-right (clear of the sidebar controls), for server-action results that are not shown inline; include a link to
  the created thing (e.g. "Run started · View run"); `role="status"`; errors use inline alert near
  the control, not toasts.

## 3. Record list / table

Object registry (`components/records/registry/<object>.ts`) defines per attribute: `key`, `label`,
`type`, `render`, `apiFilter` (param + operators), `sortable` (only if the API supports it),
`defaultVisible`, `width`, `align`. System views are registry data.

- One table per page, full-bleed inside content, no card. Header row 32 px, sticky, `--bg-subtle`,
  `--text-secondary` 12 px 500. Rows 32 px, hairline `--border-subtle`, hover `--bg-subtle`,
  selected `--bg-selected` + 2 px accent inset on the left.
- First column = identity (name, single line, 600) and sticky on horizontal scroll. Never a raw
  id as identity; reference columns show names (e.g. company name) as links.
- Cells are single-line: truncate with ellipsis + tooltip showing full value. Numbers right-aligned,
  tabular. Empty = `—` in `--text-tertiary`. ≤ 8 default columns; more via Display.
- Header click opens a menu: Sort ascending / descending / Hide column. Active sort shows an arrow
  and a Sort chip in the view bar.
- Filter chips: `Work model  is  Remote ×`. `+ Filter` → attribute picker (searchable) → operator
  (is, is not, is any of, contains, before/after, is empty) → value (enum values from API meta,
  M10). v1 is AND-only. `Clear all` resets to the view's saved state.
- Row click (or Enter) = open side panel; name link (or `o`) = full page; ⌘/Ctrl-click = new tab.
  Checkbox column appears on hover/focus only when the object has bulk actions.
- Pagination footer: `1–50 of 1,234` (or `50+` when count is off) with Prev/Next (keyset when M4
  lands). Server-side only; never fetch a whole collection. Default page size 50.
- Loading: skeleton rows (10) with the real column widths; on filter/sort transitions keep old
  rows at 60 % opacity with a 2 px progress bar in the view bar. Empty: see §7.
- Mobile: rows render as two lines (identity + 2–3 key properties); filters in a sheet.

### Implementation (UX3)

- **Registry** `components/records/registry/{jobs,companies,sources}.tsx` (`ObjectDef`): list API
  path, `view=summary` where the API has it, sorts (the API's whitelist), filters (the API's
  parameter names and contract enum values, with labels), columns (identity, default-visible,
  sort key), system views (presets of filters/sort), row preview properties.
- **URL view codec** `lib/views.ts`: parse → `ViewState` → href / API query. The URL holds view,
  `q`, filters (API names, comma lists; repeated keys accepted), `sort`, `cols`, `density`,
  `limit` (10/25/50/100) and the keyset page (`after` plus up to 20 `prev` cursors for
  "Previous"). Values the API would reject are dropped and listed as "Ignored" (never sent).
  Changing view, search, filters or sort returns to page 1 (cursors are bound to their query).
  `count` is left to the API on page 1 and `none` while paging (list contract).
- **View bar**: system-view links (`aria-current`), search (`role=search`, `/` focuses it),
  Filter and Columns panels are GET forms in wide popovers (hidden inputs keep the rest of the
  view), a Sort menu, a density link, removable chips (company names, not ids), "Reset view" when
  the URL differs from its system view. The filter panel states the API's enum semantics (value
  whatever the status).
- **Table**: a named, focusable scroll region (`width: max-content; min-width: 100%`, so cells
  never squeeze into tall rows; the page never scrolls sideways); sticky header and identity
  column; sortable headers link to the sorted view with `aria-sort`; SummaryFact cells through
  `FactSummary`; a preview button per row (popover with key properties and "Open … record").
- **Review and Runs (UX3f)**: the same registry, codec and table. Review (`market-review.md`)
  renders the server's `queueState` (resolving: action by actor; failed: the last failure; decided:
  the resolution) and uses the API's default order per status (`defaultSortFor`: priority for
  open/all, last update for resolved/dismissed). Triage claims (Market PR #22: `claimed` filter,
  claim `holder`) have a marked extension point in the review registry and are not sent until the
  contract is on main. Runs (runtime list, `market-runs.md`) is a v1 list: `paging: 'offset'` with
  the total, no sort, single-value filters, workflow keys offered as input suggestions. Labels stay
  local until `/api/meta/enums` (PR #22).
- **Review and Runs follow-ups**: a sort key can declare its natural direction (`natural:
'desc'`) and its own menu labels, so review `priority` reads "Priority: highest first" with ↓ and
  `aria-sort="descending"`. Lists without `q` (`search: false`: review, runs) report a `q` under
  Ignored instead of letting the API 400. A default sort follows the filters on link-based filter
  changes (chip ×, Clear filters): removing Resolved goes back to priority, and the view tab is
  re-derived. Choice filters can name the API default (`apiDefault`: runs `all=false` is the
  unmodified top-level view). Single-value code filters and malformed or out-of-range offsets
  (decimal only, ≤ 100000) are reported under Ignored; an offset past the end says how many rows
  there are and links to the last page. System views can set their own default columns (`cols`)
  and empty state (`empty`). Review leads with Severity; State colours only resolving and failed
  (`open` is neutral text). Runs name their source: columns are Run (the short workflow key,
  capped at 200 px), State, Source (linked from `labels.sourceId`; the name comes only from the
  sources list, never from a run label, else the id; a note says when names are unavailable or
  cover only the first 200 sources); the row's tooltip and preview heading are "key · source".
  State comes before Source so a failed run shows at 390 without scrolling. Trigger shows the
  kind only (the actor is in the preview); lineage and labels are not default columns (the
  child-runs view shows lineage).
- **UX3f re-review**: unknown URL parameters (`/runs?stat=FAILED`) and the other paging mode's
  parameters are reported under Ignored rather than dropped by the canonical redirect; a
  single-value choice reports every extra value (`all=false,true`); `status=open` is the review
  API default (`/review`). Review: Entity is not a default column (the item gives only kind and
  id); a decided item's State cell has no actor (the preview has it) and its severity is
  neutral; the preview starts with Severity, like the table; sort labels read "Created: oldest
  first / newest first"; the Subject wraps to two lines on phones (the distinguishing part is at
  the end).
- **Review follow-ups**: the table region scrolls vertically too (`max-height: max(320px,
100dvh − 240px)`), so the header sticks to the region's top; cells are capped per column
  (`maxWidth`) and a cut cell gets its full text as a tooltip; enum values read in sentence case
  (`enumLabel`, also in `StatusBadge`); table salaries are compact (`£70k–£90k / year`). A named
  view stays current only while its defining filters are present; a changed view is marked
  "(modified)" and is not `aria-current`. GET-form submissions redirect to the canonical URL
  (no empty parameters, one comma list per parameter) unless values were ignored. Rows per page
  10/25/50/100 in the pager; past the 20-cursor trail rows are unnumbered ("50 rows · page 23+");
  an emptied page offers First/Previous. The focused row uses the selected-row style. Focus returned
  by a closing layer does not show the trigger's tooltip.
- **Keyboard**: one Tab stop per row (the name link; other row controls leave the Tab order and are
  reached through the preview); `Space`/`p` opens the row preview; `j`/`k` anywhere on the list, `↓`/`↑` inside the
  table; `Enter` opens the record. (`Enter` = side panel comes with UX4.)
- **Re-review details**: an explicit `view=` of the first view is kept in the URL when the query
  alone would select another tab (`/jobs?view=all&workModel=remote` stays on All, modified, and
  every link built from it keeps that tab). The view-tab strip scrolls the current tab into view
  (horizontally) at phone width. On keyset page 2, First page is shown disabled (it equals
  Previous). A row is remembered for Back only on a plain click (not ⌘/Ctrl/Shift/Alt clicks,
  which open another tab). Source names are a `Map`, so an id such as `constructor` never reads
  an inherited property.
- **States**: `loading.tsx` skeleton per list (detail routes have their own); empty with and
  without filters; API errors via `ApiErrorPanel`, plus "Back to the first page" for a stale
  cursor.

## 4. Property rendering

`PropertyRow` = label (12 px `--text-secondary`, 160 px column, wraps) | value (13 px) |
trailing affordances (confidence, provenance). Grouped under 14 px section headings with a
hairline — no boxes.

| Type                | Rendering                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text                | plain; long text clamps to 3 lines with "Show more"                                                                                                           |
| enum                | humanised label from API meta (M10); falls back to `humanize()` of the raw value                                                                              |
| status              | `StatusPill`: 20 px, radius full, dot + text (11–12 px 500), tone from the tone map                                                                           |
| boolean / tri-state | Yes / No / Unknown (Unknown in tertiary), never a bare check mark                                                                                             |
| number / money      | tabular; money shows range + currency + period ("£70k–£90k / year"); original text and annualisation assumptions in tooltip; parse warnings as a warning pill |
| date/time           | see _Timestamps_                                                                                                                                              |
| URL                 | hostname + external-link icon, full URL in tooltip, `target=_blank rel="noopener noreferrer nofollow"`; non-http(s) shown as plain mono text                  |
| record reference    | chip with object icon + name, links to the record, peek on Shift-click                                                                                        |
| list                | comma-separated, first 3 then `+N` (popover with all)                                                                                                         |
| location            | formatted city, region, country; a remote _label_ is shown as listed text, never converted into a work model                                                  |
| JSON / ids          | only in Debug tab or behind "Raw" disclosure; ids use `CopyButton`                                                                                            |

**Facts** (`Fact<T>` from the API):

- `known` → value. `unknown` → _Unknown_ (tertiary) + reason tooltip from `confidence.reasons`.
- `conflicting` → value + warning pill "Conflicting" with count; the conflict list opens in the
  provenance popover. Retained lower-authority alternates on a `known` fact → neutral `+2 other
values` link (never danger).
- **Confidence indicator**: 3-segment meter (high 3, medium 2, low 1, unknown 0/outlined) with
  `aria-label="Confidence: medium, score 0.62"`. Detail/panel: always shown. Tables: shown only for
  low/unknown to keep rows calm.
- **Provenance affordance**: trailing button `2 sources` (secondary text, 12 px) → popover listing
  evidence: source name + authority pill, observed time, quote (2-line clamp), links _Observation ·
  Snapshot · Artifact_ (artifacts only via the safe `/artifacts/:id` proxy). Footer: "All evidence
  →" to the Evidence tab anchored at the field. Policy/extractor versions appear in the popover
  footer, not inline.
- **Timestamps**: `<time dateTime>` always. Lists: relative ("3m ago", "5h ago", "Tue", "12 Sep",
  "12 Sep 2025" beyond this year); future: "in 3h"; overdue gets a warning pill "Overdue".
  Record pages: absolute "12 Sep 2026, 14:03 UTC" + relative in secondary. Tooltip always shows
  UTC and local time.
- **Source links**: source names (not keys/ids) with authority pill where authority matters.

## 5. Side panel (peek)

- URL-addressed: `?peek=<id>` on list routes; server-rendered; back/forward work. Desktop: 440 px,
  resizable 360–720 (width in cookie), list stays interactive. Tablet: overlays with scrim.
  Mobile: navigates to the record page.
- Semantics: `<aside aria-labelledby>` region; on open focus moves to the panel heading; `Esc`
  closes and returns focus to the originating row; `↑/↓` or `k/j` move to previous/next record in
  the current view ("3 of 214 in _Remote · worldwide_").
- Content: header (name, status pills, open-full-page, close), alerts (conflicts, open reviews,
  merged), ≤ 10 key properties from the registry, 5 latest activity items, primary action.

## 6. Record page

```
Breadcrumbs: Jobs › Senior Backend Engineer
[icon] Senior Backend Engineer            [Verify now] [Re-interpret] […]
Acme Ltd · Remote (UK) · Verified live · Last seen 2h ago
⚠ 3 conflicting fields · 1 open review                        (alerts strip, only when needed)
Overview | Evidence (12) | Activity | Related · Jobs 14 · Sources 2 | Debug
┌ main (properties grouped) ──────────────────────┬ rail 320: Highlights ┐
```

- Header: object icon or letter avatar (never fetched logos), h1 20 px, ≤ 3 status pills, one
  critical-metadata line (4–5 items, `·` separated), one primary action, secondary actions as
  buttons (≤ 2) then `…` (Copy id, Copy link, Open raw JSON, destructive items last with inline
  confirm).
- Tabs are nested routes (`/jobs/[id]`, `/jobs/[id]/evidence`, `/activity`, `/related`, `/debug`)
  sharing a layout that renders the header once; each tab streams with its own skeleton.
- **Overview** = Properties & Intelligence, grouped (Job: Role · Work model & location ·
  Sponsorship & authorization · Compensation · Requirements; Company: Identity · Geography ·
  Employment & sponsor licence · Firmographics). Right rail "Highlights": freshness, verification,
  quality (sources, observations, conflicts), open reviews.
- **Evidence** = Evidence & Provenance: per-field evidence tables, conflicts, source copies,
  observations, snapshots/artifacts.
- **Activity** = Activity & History: one timeline (lifecycle transitions, verifications, review
  decisions, audit, runs), newest first, filter by kind, paginated.
- **Related**: sub-tables using the same `RecordTable` (company → jobs, job sources; job → company,
  duplicates/distinct-from; source → runs, snapshots).
- **Debug** = Operational/raw: ids, versions (logic/policy/taxonomy), interpretation flags, AI
  proposals, overrides, dedupe keys, raw JSON. Never removed; never on Overview.

Object specifics: _Source_ primary = Run now; Enable/Disable in `…` with confirm. _Review item_
uses the review workspace (split list + item; compare view; typed decision composer; decide & next).
_Run_ follows §10 run mode.

## 7. States

| State                  | Rule                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading (route)        | `loading.tsx` per segment renders skeletons shaped like the target (header + rows); no page spinners; `aria-busy` on the region                            |
| Loading (action)       | button shows spinner + "Working…", `aria-busy`, disabled; result inline (`role=status`) or toast with link                                                 |
| Empty (never had data) | one sentence + primary next step ("No sources yet · New source"); no illustrations                                                                         |
| Empty (filtered)       | "No jobs match these filters" + `Clear filters`                                                                                                            |
| Error (API)            | keep `ApiErrorPanel` content (message, code, HTTP status, request id, path) in a calm danger callout with Retry; section-level errors never blank the page |
| API unavailable        | health dot turns red + one shell-level callout; pages show cached-nothing error, not stack traces                                                          |
| Not found / merged     | "This company was merged into X" callout linking the survivor (existing behaviour)                                                                         |
| Stale data             | freshness overdue shown as warning pill with "Overdue by 2d"                                                                                               |

## 8. Keyboard map

| Keys                                 | Action                                                              | Scope              |
| ------------------------------------ | ------------------------------------------------------------------- | ------------------ |
| `⌘K` / `Ctrl K`                      | command menu                                                        | global             |
| `/`                                  | focus search / filter input                                         | global, list       |
| `?`                                  | shortcuts help dialog                                               | global             |
| `g` then `h` `r` `c` `j` `s` `w` `u` | Home, Review, Companies, Jobs, Sources, Workflows, Runs             | global             |
| `[`                                  | toggle sidebar                                                      | global             |
| `j` / `k` (`↓` / `↑`)                | next / previous row (also in panel)                                 | list, panel        |
| `Enter` / `Space`                    | open side panel for focused row                                     | list               |
| `o` / `⌘Enter`                       | open full record page (new tab with ⌘)                              | list, panel        |
| `Esc`                                | close innermost layer (menu → dialog → panel), then clear selection | all                |
| `f` / `s` / `v`                      | add filter / sort / switch view                                     | list               |
| `1`…`5`                              | switch record tab                                                   | record page        |
| `.`                                  | open `…` actions menu                                               | record page        |
| `c` then `i` / `l`                   | copy id / copy link                                                 | record page, panel |
| `1`…`8` then `⌘Enter`                | choose review action, submit decision                               | review item        |
| `n`                                  | next open review item (after decision)                              | review             |
| `r`                                  | retry selected failed node (with confirm)                           | run                |

Single-key shortcuts never fire inside inputs/textareas/contenteditable, respect IME composition,
and are listed in ⌘K next to their commands. No shortcut is the only path to an action.

## 9. Accessibility

- WCAG 2.2 AA: text ≥ 4.5:1, UI boundaries and focus ≥ 3:1, targets ≥ 24 px; checked in both themes.
- Landmarks: skip link → `main#main`; `nav[aria-label=Main]`; one `h1` per page; heading levels
  never skip. Tables keep `<caption>` (visually hidden) and `scope`.
- Focus: visible `--focus-ring` on every interactive element; focus trapped only in modal dialogs;
  restored to the invoker on close; roving tabindex inside tables, menus, tabs, command list.
- ARIA patterns: menus `menu/menuitem`, tabs `tablist`, ⌘K `combobox` + `listbox`, sorting
  `aria-sort`, pills/indicators with accessible text, live regions for action results.
- Motion respects `prefers-reduced-motion`; no auto-refresh that moves focus (run polling updates
  in place and announces state changes politely).
- Every icon-only button has `aria-label` + tooltip; tooltips are also shown on focus.

## 10. Workflows & runs

Principles for the definition canvas, run mode and (future) authoring:

- **Definition mode**: left-to-right layered DAG on a quiet dotted canvas; the **trigger** is the
  first, visually distinct node (schedule/manual/event + next fire). Nodes are 240×56 cards: icon,
  title, capability `type@version` in secondary; edges are simple orthogonal lines; branch
  conditions label the edge (`branch = found`); fan-out nodes show a stacked edge.
- **Selection**: one selected node at a time — 2 px accent ring + raised elevation; details in a
  single right **config panel** (Config · Input mapping · Retry & timeout · Capability schema). No
  modals on the canvas.
- **Add-step** (when authoring exists): `+` appears on hover of an edge or node output and via `b`;
  opens a searchable capability picker in place; the new node is auto-selected with its config open.
- **Run mode** is a separate toggle/route (`/workflows/[key]/runs/[runId]` or `/runs/[id]`): the
  same graph overlaid with per-node status (pill + icon), duration, attempts ("2/4"), retry badge;
  the executed path is emphasised and unexecuted/skipped nodes are muted. Selecting a node opens
  the inspector: Status & timing · Input · Output (preview, offloaded artifact link) · Logs ·
  Attempts · Actions (Retry / Resume / open child runs).
- **Run header/timeline** (Vercel/Railway-inspired): state, trigger, started, duration, version;
  a compact duration bar per node (queued vs running) under the header. Non-terminal runs poll
  (`router.refresh()` every 3 s, paused when the tab is hidden).
- **Runs list**: status, workflow, trigger, started (relative), duration, failed node; filters for
  state/workflow/trigger/time.
- Vocabulary in the main UI: "step" for node, "run", "attempt", "retry"; queue names and lease
  details stay in the inspector's Debug section.

## 11. Copy and implementation rules

- Humanise enums from API labels; sentence case; product language ("Failing for 4 runs, last
  success 3 days ago") over counters; say what the operator can do next.
- File layout: `components/ui/*` (domain-free; may not import `@/lib/api` or `components/records`),
  `components/records/*` (registry, table, panel, property renderers), `app/**` (routes, data
  loading only), `styles/*`.
- Server components by default; `'use client'` only for interactive leaves (menus, panel resize,
  hotkeys, ⌘K). All data from `lib/api.ts` on the server; mutations via server actions.
- New tokens or components are added here first (same PR) — this document is the source of truth.

## 12. Primitives (`components/ui`, UX2)

Domain-free, CSS Modules on semantic tokens, catalogued at `/settings/ui` (development only; in a
production build only with `ADMIN_UI_CATALOGUE=1`, which the e2e sets to run axe on it).

| Primitive                         | Contract                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button` / `ButtonLink`           | primary · secondary · ghost · danger; `sm` 28 / `md` 32 px; `pending` = disabled + `aria-busy` + spinner + "Working…"; links are `ButtonLink` (navigation, not actions)                                                                                                                                                           |
| `IconButton`                      | required `label` = accessible name = tooltip                                                                                                                                                                                                                                                                                      |
| `StatusPill`                      | tone + dot + text (`lib/tones.ts` maps enum values to tones; `Badge` reads the same map)                                                                                                                                                                                                                                          |
| `Tooltip`                         | hover after 400 ms, keyboard focus at once, `Esc` hides (top of the layer stack, so never an enclosing dialog), hoverable; description via `aria-describedby` (off for icon buttons); child must be a client-created element                                                                                                      |
| `Popover`                         | non-modal `role="dialog"` labelled panel; focus moves in once visible; `Esc` returns focus; outside click or focus leaving closes; trigger must be a client-created element                                                                                                                                                       |
| `Menu`                            | WAI-ARIA menu button: ↓/Enter/Space open on first, ↑ on last; ↑/↓/Home/End, type-ahead (no Ctrl/Meta/Alt), `Esc` returns focus, Tab or focus leaving closes; visible focus ring; disabled items skipped; danger items last; shortcut hints are hidden from the name (`aria-keyshortcuts` for chords, a description for sequences) |
| `Dialog`                          | native `<dialog>` + `showModal()` (focus trap, inert page, focus restored); `Esc`, close button and backdrop (press and release on it) call `onClose`; an unrequested native close also calls `onClose`                                                                                                                           |
| `Tabs`                            | automatic activation, one tab stop, ←/→/Home/End; all panels render, inactive ones `hidden`, so `aria-controls` always resolves (route tabs for record pages come in UX6)                                                                                                                                                         |
| `Kbd`, `Skeleton`, `SkeletonRows` | hint keys; decorative skeletons inside an `aria-busy` region with a text status                                                                                                                                                                                                                                                   |
| `EmptyState`, `ErrorState`        | one sentence + next step; calm danger callout with diagnostics and Retry (`router.refresh()`); `ApiErrorPanel` renders `ErrorState`                                                                                                                                                                                               |
| `PropertyList`                    | 160 px label column (stacks on phones); empty values render "—"                                                                                                                                                                                                                                                                   |
| `Time`                            | §4 timestamps; UTC maths with fixed month names; the browser clock (1-minute tick, server snapshot `null`) drives relative text after mount, so hydration never mismatches; tooltip adds local time after mount                                                                                                                   |
| `ConfidenceIndicator`             | 3-segment meter (`role="img"`, name "Confidence: medium, score 0.62"); unknown = dashed outline, low = warning tone                                                                                                                                                                                                               |
| `CopyButton`                      | clipboard copy (textarea + copy-command fallback without the Clipboard API, placed next to the button so focus stays in its layer and is restored); "Copied" announced, "Copy failed" visible and announced                                                                                                                       |
| `ToastProvider` / `useToast`      | bottom-right, 6 s (paused on hover/focus), dismissible, optional link; a `role="status"` region (`aria-atomic=false`) holds only the message text (links and dismiss buttons sit outside it); `ActionForm feedback="toast"` gives one toast per result (StrictMode-safe); errors stay inline                                      |

Floating layers (tooltip, popover, menu) render with `popover="manual"` in the top layer and are
positioned by `floating.ts` (flip + clamp to the viewport). Initial focus runs in `useFloating`'s
`onShown`, after `showPopover()`: a closed `[popover]` is `display: none` and cannot take focus.
Open layers form a stack (`useEscapeLayer`, registered in a layout effect; a layer that contains
another stays below it, so layers opened in the same commit still stack innermost-last): one
capture-phase listener gives Escape to the innermost layer only and consumes it
(`stopImmediatePropagation`), so an enclosing popover or native `<dialog>` stays open; Escape during
IME composition is left to the IME. A popover with nothing focusable shows a focus ring on itself.
Motion is opacity/transform only and off under `prefers-reduced-motion`.

## 13. Facts (`components/records/facts`, UX5)

`FactProperty` renders one `Fact<T>` exactly as the API returns it (contract
`market-provenance.md`, v1 and v1.1 shapes); `FactGroup` is its `<dl>`. It replaced `FactView` on
company and job pages (`EvidenceList` remains for the review and licence tables). The rules are
also in the component's header comment.

- **Status** comes only from `fact.status`. `known` → the value. `unknown` → _Unknown_ plus
  "Basis: …" inline (tooltip + screen-reader text in `compact`). `conflicting` → the value (or
  "No value") plus a warning **"Sources disagree · N"** button whose popover lists the
  disagreeing values. Any other status (a domain state such as `expired`) → a neutral pill with
  that status, never rendered as known. A fact the API did not mark conflicting but that kept
  `conflicts[]` shows a neutral **"+N other values"** popover — never a warning.
- **Value on record**: an Unknown (or other-status) fact that still carries a value keeps
  "Unknown" (or the status) as its label; the value is a secondary "Value on record: …" line in
  the full view and in the provenance popover.
- **Header and lists agree with the rows**: `ConflictFields` labels each API
  `quality.conflictFields` entry by that fact's own status in the same response — "Sources
  disagree: …" (warning) for `conflicting`, "Flagged with other values: …" (neutral) otherwise —
  worded as flagged fields, not a complete list (reconcilers flag some fields only; the tooltip
  points at the rows' own "+N other values"); tables show "N fields where sources disagree · N
  fields with other values". A listed field with no resolvable fact stays under "Sources
  disagree". `lib/tones.ts` maps `conflicting` to warning.
- **Provenance**: the trailing `N sources` button (distinct `sourceId`s) opens a popover: basis
  (`confidence.reasons`), each evidence item (source link, or "Operator override" linked to the
  record's overrides/audit section for the pre-M7.1 literal `operator` — the link moves focus to
  that section, which closes the popover; authority pill, observed
  time, quote clamped to two lines with "Show full quote" when long, locator, extractor) with
  `Observation · Snapshot` (`ObservationLink`/`SnapshotLink`) and `Artifact` (safe proxy, new tab)
  links, then policy version and update time. Source → observation → artifact is two clicks
  (FR-23, e2e-checked). With no evidence, "No evidence" is plain text and the basis is inline.
- A recorded basis of `none` is not shown as "Basis: none" (inline nothing; the popover says "no
  basis recorded").
- **Confidence**: bars plus the level as a visible word (sentence case). `full` shows it except on an Unknown fact
  of unknown confidence (the word "Unknown" already says it; the popover states the level);
  `compact` only when it adds something: low confidence, or a value whose confidence is unknown.
- Popover triggers are built client-side (`FactPopover`): `Popover` clones its trigger, and a
  server-created element can arrive as an uncloneable lazy Flight reference (seen on job pages
  with retained alternates); `Popover` throws a clear error for a non-element trigger.
- **Summaries**: `FactSummary` renders a `SummaryFact` (`INTEGRATION_CONTRACTS.md` § Summary
  convention, Market API v2) or a v1 full `Fact` in a table cell with the same status labels,
  a neutral `+N` for `alternates` (v1: the length of `conflicts[]`, the number v2 sends), and
  `basis` as tooltip + screen-reader text when present. The Jobs table uses it for work model,
  remote scope, sponsorship and salary.
- **Sponsorship** (`SponsorshipValue`): the role statement and the employer capability are shown
  as separate axes ("Role says nothing · Employer holds a licence (GB)"); the employer axis is
  always shown ("Employer: no licence on record", "Employer: unknown"); an `unclear` status is
  also said in words ("Unclear"); the combined API status is the tooltip. An employer licence is never worded as the role sponsoring.
- The `/settings/ui` catalogue shows every fact state (known, other values, sources disagree,
  unknown, unknown with a value on record, other status, no evidence) and the summaries, so axe
  covers states the demo seed may not produce. Demo evidence is operator evidence without record
  ids, so no demo link 404s.
- Value renderers stay in the page and render the API value only; the component never infers.
