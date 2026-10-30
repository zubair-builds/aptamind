/**
 * URL view codec for record lists (design system §3, stream plan UX3a). The URL is the whole view:
 * system view, search, filters, sort, visible columns, density and the keyset page. Nothing is
 * kept in local storage. Filter and sort names and values are exactly the list API's (market
 * contracts), so a URL is also a readable API query; the codec only drops values the contract
 * would reject (so a hand-edited URL never turns into a 400) and reports them.
 */

export type RawParams = Record<string, string | string[] | undefined>;

export type FilterSpec =
  /** Multi-value enum; values OR within the parameter. */
  | { param: string; label: string; kind: 'enum'; values: readonly string[]; labels?: Record<string, string> }
  /** One value from a fixed set (booleans, tri-states). */
  | {
      param: string;
      label: string;
      kind: 'choice';
      values: readonly string[];
      labels?: Record<string, string>;
      /** Label of "no value" (what the API does without the parameter); default "any". */
      emptyLabel?: string;
      /** Values offered in the form (all `values` stay valid in a URL). */
      formValues?: readonly string[];
      /** The value the API uses without the parameter: accepted, then dropped (it is the default). */
      apiDefault?: string;
    }
  /** Free codes (ISO-2 countries, ids, flag codes): a comma list, each matching `pattern`. */
  | {
      param: string;
      label: string;
      kind: 'codes';
      pattern: RegExp;
      transform?: 'upper' | 'lower';
      placeholder?: string;
      max?: number;
    }
  /** A date `YYYY-MM-DD` (the API also takes date-times; the UI sends dates). */
  | { param: string; label: string; kind: 'date' }
  /** A non-negative number. */
  | { param: string; label: string; kind: 'number'; min?: number; max?: number };

export interface SortSpec {
  /** API sort key (without the `-`). */
  key: string;
  label: string;
  /**
   * The API's direction for the bare key. Most keys sort ascending; `desc` means the bare key
   * already sorts highest first (review `priority`), so `-key` is the ascending one.
   */
  natural?: 'asc' | 'desc';
  /** Menu labels for [bare key, `-key`] (default: "↑ ascending" / "↓ descending"). */
  labels?: readonly [string, string];
}

export interface SystemViewSpec {
  id: string;
  label: string;
  filters?: Record<string, string[]>;
  sort?: string;
  /** Default columns of this view (e.g. Open review items omit State). */
  cols?: readonly string[];
  /** Empty state of the unmodified view ("No resolved items yet."). */
  empty?: string;
}

export interface ViewSchema {
  path: string;
  sorts: readonly SortSpec[];
  /** Default API sort, e.g. `-lastSeenAt` (what the API applies without `sort`); '' = no sort. */
  defaultSort: string;
  /** When the API's default sort depends on a filter (review: `-updatedAt` for decided items). */
  defaultSortFor?: (filters: Record<string, string[]>) => string | undefined;
  /**
   * `keyset` (list v2: `after`/`nextCursor`, `count=none` while paging) or `offset` (v1 lists
   * such as the runtime's runs: `offset`, `total`).
   */
  paging?: 'keyset' | 'offset';
  /** API name of the keyset cursor (default `after`; the imports list calls it `cursor`). */
  cursorParam?: string;
  /** False when the list API has no `count` parameter (it never returns a total). */
  countParam?: boolean;
  filters: readonly FilterSpec[];
  /** Column keys in display order; `identity` is always shown. */
  columns: readonly { key: string; defaultVisible?: boolean; identity?: boolean }[];
  views: readonly SystemViewSpec[];
  /** `view=summary` rows from the API (jobs, companies). */
  summaryView?: boolean;
  /** False when the list API has no `q` (review, runs): a `q` in the URL is ignored and reported. */
  search?: boolean;
  /** Cross-parameter rules the API enforces (e.g. `minAnnual` needs exactly one currency). */
  crossCheck?: (filters: Record<string, string[]>) => { param: string; reason: string }[];
}

export type Density = 'compact' | 'comfortable';

export interface ViewState {
  view: string;
  q: string;
  filters: Record<string, string[]>;
  sort: string;
  /** Visible column keys, or null for the defaults. */
  cols: string[] | null;
  density: Density;
  /** Keyset cursor of the current page (null = first page). */
  after: string | null;
  /** Offset paging only: index of the first row. */
  offset: number;
  /** Cursors of the pages before this one ('' = the first page), oldest first. */
  prev: string[];
  limit: number;
  /** Values dropped from the URL because the API would reject them. */
  ignored: { param: string; value: string; reason: string }[];
}

export const PAGE_SIZE = 50;
/** Page sizes a URL may ask for (the API allows 1–200; the design system default is 50). */
export const PAGE_SIZES = [10, 25, 50, 100] as const;
/** Previous-page cursors kept in the URL; older pages are reached through "First page". */
export const MAX_TRAIL = 20;
const MAX_CURSOR = 2000;
const MAX_Q = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** UI-only parameters (everything else is an API filter name). */
export const UI_PARAMS = [
  'view',
  'q',
  'sort',
  'cols',
  'density',
  'after',
  'prev',
  'offset',
  'limit',
] as const;
const MAX_OFFSET = 100_000;

/** The API's default sort for these filters. */
export function sortDefault(schema: ViewSchema, filters: Record<string, string[]>): string {
  return schema.defaultSortFor?.(filters) ?? schema.defaultSort;
}

function list(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw])
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

function first(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

const uniq = (a: string[]) => [...new Set(a)];

/** A real calendar date: `2026-02-31` parses (rolls over) but does not round-trip, so it is rejected. */
function isCalendarDate(v: string) {
  if (!DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Whether the filters still contain every value that defines a system view. */
function containsView(view: SystemViewSpec, filters: Record<string, string[]>) {
  return Object.entries(view.filters ?? {}).every(([k, vals]) => vals.every((v) => filters[k]?.includes(v)));
}

/** The system view a query equals, else the first view (the tab of a URL without `view=`). */
function matchingView(schema: ViewSchema, q: string, filters: Record<string, string[]>, sort: string) {
  const probe = { q, filters, sort } as ViewState;
  return (
    schema.views.find((v) => !isModified(schema, { ...presetState(schema, v.id), ...probe, view: v.id }))
      ?.id ?? schema.views[0]!.id
  );
}

/** Validates the raw values of one filter; returns the kept values and the rejected ones. */
export function parseFilter(spec: FilterSpec, raw: string | string[] | undefined) {
  const kept: string[] = [];
  const rejected: { value: string; reason: string }[] = [];
  const values = list(raw);
  switch (spec.kind) {
    case 'enum':
      for (const v of values)
        if (spec.values.includes(v)) kept.push(v);
        else rejected.push({ value: v, reason: 'not a value of this filter' });
      break;
    case 'choice': {
      // One value: the first counts (the API default counts too, and is then left out).
      let taken = false;
      for (const v of values)
        if (spec.apiDefault !== undefined && v === spec.apiDefault && !taken) taken = true;
        else if (spec.values.includes(v) && !taken) {
          taken = true;
          kept.push(v);
        } else
          rejected.push({
            value: v,
            reason: spec.values.includes(v) ? 'only one value allowed' : 'not a value of this filter',
          });
      break;
    }
    case 'codes':
      for (const v0 of values) {
        const v =
          spec.transform === 'upper' ? v0.toUpperCase() : spec.transform === 'lower' ? v0.toLowerCase() : v0;
        if (!spec.pattern.test(v)) rejected.push({ value: v0, reason: 'not a valid code' });
        else if (kept.length >= (spec.max ?? 50) && !kept.includes(v))
          rejected.push({ value: v0, reason: spec.max === 1 ? 'only one value allowed' : 'too many values' });
        else kept.push(v);
      }
      break;
    case 'date':
      for (const v of values)
        if (isCalendarDate(v) && !kept.length) kept.push(v);
        else rejected.push({ value: v, reason: 'expected a date (YYYY-MM-DD)' });
      break;
    case 'number':
      for (const v of values) {
        const n = Number(v);
        if (
          v !== '' &&
          Number.isFinite(n) &&
          n >= (spec.min ?? 0) &&
          n <= (spec.max ?? 100_000_000) &&
          !kept.length
        )
          kept.push(String(n));
        else rejected.push({ value: v, reason: 'expected a number' });
      }
      break;
  }
  const max = spec.kind === 'codes' ? (spec.max ?? 50) : 50;
  return { kept: uniq(kept).slice(0, max), rejected };
}

const sortKey = (sort: string) => sort.replace(/^-/, '');

function validSort(schema: ViewSchema, sort: string | undefined): sort is string {
  return !!sort && schema.sorts.some((s) => s.key === sortKey(sort));
}

/** The state a system view starts from (its filters and sort; default columns and density). */
export function presetState(schema: ViewSchema, viewId: string): ViewState {
  const v = schema.views.find((x) => x.id === viewId) ?? schema.views[0]!;
  return {
    view: v.id,
    q: '',
    filters: Object.fromEntries(Object.entries(v.filters ?? {}).map(([k, vals]) => [k, [...vals]])),
    sort: v.sort ?? sortDefault(schema, v.filters ?? {}),
    cols: null,
    density: 'compact',
    after: null,
    offset: 0,
    prev: [],
    limit: PAGE_SIZE,
    ignored: [],
  };
}

const sameFilters = (a: Record<string, string[]>, b: Record<string, string[]>) => {
  const ka = Object.keys(a).filter((k) => a[k]!.length);
  const kb = Object.keys(b).filter((k) => b[k]!.length);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => {
    const x = [...a[k]!].sort();
    const y = [...(b[k] ?? [])].sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
  });
};

/** Whether the query (search, filters, sort) differs from the system view it is based on. */
export function isModified(schema: ViewSchema, state: ViewState): boolean {
  const base = presetState(schema, state.view);
  return state.q !== '' || state.sort !== base.sort || !sameFilters(state.filters, base.filters);
}

/** Parses a list URL. Unknown parameters and invalid values are ignored and reported. */
export function parseView(schema: ViewSchema, raw: RawParams): ViewState {
  const ignored: ViewState['ignored'] = [];
  // A mistyped parameter (`stat=FAILED`) is reported, not silently dropped by the canonical
  // redirect; so are the other paging mode's parameters.
  const known = new Set<string>([
    ...schema.filters.map((f) => f.param),
    ...UI_PARAMS.filter((k) => (schema.paging === 'offset' ? k !== 'after' && k !== 'prev' : k !== 'offset')),
  ]);
  for (const [k, v] of Object.entries(raw))
    if (v !== undefined && !known.has(k))
      ignored.push({
        param: k,
        value: (Array.isArray(v) ? v : [v]).join(','),
        reason: 'not a parameter of this list',
      });
  const filters: Record<string, string[]> = {};
  for (const spec of schema.filters) {
    const { kept, rejected } = parseFilter(spec, raw[spec.param]);
    if (kept.length) filters[spec.param] = kept;
    for (const r of rejected) ignored.push({ param: spec.param, ...r });
  }
  for (const c of schema.crossCheck?.(filters) ?? []) {
    for (const v of filters[c.param] ?? []) ignored.push({ param: c.param, value: v, reason: c.reason });
    delete filters[c.param];
  }
  const rawSort = first(raw.sort);
  const sort = validSort(schema, rawSort) ? rawSort : sortDefault(schema, filters);
  if (rawSort && sort !== rawSort)
    ignored.push({ param: 'sort', value: rawSort, reason: 'not a sort of this list' });
  let q = (first(raw.q) ?? '').trim().slice(0, MAX_Q);
  if (q && schema.search === false) {
    ignored.push({ param: 'q', value: q, reason: 'this list has no search' });
    q = '';
  }

  const keys = new Set(schema.columns.map((c) => c.key));
  const colsRaw = list(raw.cols).filter((c) => keys.has(c));
  const colsFromUrl = colsRaw.length ? uniq(colsRaw) : null;

  const offsetMode = schema.paging === 'offset';
  const after = offsetMode ? undefined : first(raw.after);
  const offsetRaw = first(raw.offset);
  let offset = 0;
  if (offsetMode && offsetRaw !== undefined && offsetRaw !== '') {
    // Decimal digits only ("0x10", "1e3", "2.5" are not offsets), within the API's range.
    if (/^\d{1,7}$/.test(offsetRaw) && Number(offsetRaw) <= MAX_OFFSET) offset = Number(offsetRaw);
    else
      ignored.push({
        param: 'offset',
        value: offsetRaw,
        reason: `an offset is a whole number 0–${MAX_OFFSET}`,
      });
  }
  const prev = (raw.prev === undefined ? [] : Array.isArray(raw.prev) ? raw.prev : [raw.prev])
    .filter((c) => c.length <= MAX_CURSOR)
    .slice(-MAX_TRAIL);

  const rawLimit = first(raw.limit);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(Number(rawLimit))
    ? Number(rawLimit)
    : PAGE_SIZE;
  if (rawLimit !== undefined && pageSize !== Number(rawLimit))
    ignored.push({ param: 'limit', value: rawLimit, reason: `page size is one of ${PAGE_SIZES.join(', ')}` });

  // The view tab: the named one, else a system view whose query this URL equals, else the first.
  // A named view is kept only while the filters still contain the ones that define it (removing
  // the Remote view's `workModel=remote` is no longer the Remote view).
  const named = first(raw.view);
  const namedView = schema.views.find((v) => v.id === named);
  const view =
    namedView && containsView(namedView, filters) ? namedView.id : matchingView(schema, q, filters, sort);
  return {
    view,
    q,
    filters,
    sort,
    cols: colsFromUrl,
    density: first(raw.density) === 'comfortable' ? 'comfortable' : 'compact',
    after: after && after.length <= MAX_CURSOR ? after : null,
    offset,
    prev: after ? prev : [],
    limit: pageSize,
    ignored,
  };
}

/** Visible columns: the URL's choice, else the view's or each column's default; identity first. */
export function visibleColumns(
  schema: ViewSchema,
  state: Pick<ViewState, 'cols'> & { view?: string },
): string[] {
  const identity = schema.columns.filter((c) => c.identity).map((c) => c.key);
  const viewCols = schema.views.find((v) => v.id === state.view)?.cols;
  const chosen =
    state.cols ??
    (viewCols ? [...viewCols] : schema.columns.filter((c) => c.defaultVisible).map((c) => c.key));
  return [
    ...identity,
    ...schema.columns.map((c) => c.key).filter((k) => !identity.includes(k) && chosen.includes(k)),
  ];
}

const defaultCols = (schema: ViewSchema, viewId?: string) => {
  const v = schema.views.find((x) => x.id === viewId);
  return v?.cols
    ? v.cols.filter((k) => !schema.columns.find((c) => c.key === k)?.identity)
    : schema.columns.filter((c) => c.defaultVisible && !c.identity).map((c) => c.key);
};

/** URL parameters for a state, in a stable order, leaving defaults out. */
export function viewParams(schema: ViewSchema, state: ViewState): URLSearchParams {
  const p = new URLSearchParams();
  // `view=` is written for any view but the first, and for the first one too when the query
  // alone would select another tab (`view=all&workModel=remote` stays on All, modified).
  if (
    state.view !== schema.views[0]!.id ||
    matchingView(schema, state.q, state.filters, state.sort) !== state.view
  )
    p.set('view', state.view);
  if (state.q) p.set('q', state.q);
  for (const spec of schema.filters) {
    const v = state.filters[spec.param];
    if (v?.length) p.set(spec.param, v.join(','));
  }
  if (state.sort && state.sort !== sortDefault(schema, state.filters)) p.set('sort', state.sort);
  if (state.cols) {
    const nonIdentity = state.cols.filter((c) => !schema.columns.find((x) => x.key === c)?.identity);
    const d = defaultCols(schema, state.view);
    const same = nonIdentity.length === d.length && nonIdentity.every((c) => d.includes(c));
    // Only identity columns chosen: name them, since an empty `cols` means "the defaults".
    const identity = schema.columns.filter((c) => c.identity).map((c) => c.key);
    if (!same) p.set('cols', (nonIdentity.length ? nonIdentity : identity).join(','));
  }
  if (state.density !== 'compact') p.set('density', state.density);
  if (state.limit !== PAGE_SIZE) p.set('limit', String(state.limit));
  if (state.offset > 0) p.set('offset', String(state.offset));
  if (state.after) {
    p.set('after', state.after);
    for (const c of state.prev) p.append('prev', c);
  }
  return p;
}

/**
 * Href for `state` changed by `patch`. Any change to what is listed (view, search, filters, sort)
 * goes back to the first page, because a keyset cursor is bound to its query and sort.
 */
export function viewHref(schema: ViewSchema, state: ViewState, patch: Partial<ViewState> = {}): string {
  const requery = ['view', 'q', 'filters', 'sort'].some((k) => k in patch);
  // A filter change keeps an explicitly chosen sort, but a default sort follows the new filters
  // (review: removing `status=resolved` goes back to the priority order).
  const sortPatch =
    patch.filters && !('sort' in patch) && state.sort === sortDefault(schema, state.filters)
      ? { sort: sortDefault(schema, patch.filters) }
      : {};
  const next: ViewState = {
    ...state,
    ...patch,
    ...sortPatch,
    ...(requery && !('after' in patch) && !('offset' in patch) ? { after: null, prev: [], offset: 0 } : {}),
  };
  // A filter change that no longer contains the view's own filters leaves that view (removing
  // the Resolved chip is the Open queue again), as parsing the resulting URL would.
  if (patch.filters && !('view' in patch)) {
    const v = schema.views.find((x) => x.id === next.view);
    if (!v || !containsView(v, next.filters))
      next.view = matchingView(schema, next.q, next.filters, next.sort);
  }
  const qs = viewParams(schema, next).toString();
  return qs ? `${schema.path}?${qs}` : schema.path;
}

/** Href of a system view (its preset), keeping columns and density. */
export function systemViewHref(schema: ViewSchema, state: ViewState, viewId: string): string {
  const base = presetState(schema, viewId);
  return viewHref(schema, { ...base, cols: state.cols, density: state.density });
}

/** Next page (the API's `nextCursor`) and previous page links. */
export function nextPageHref(schema: ViewSchema, state: ViewState, nextCursor: string): string {
  const prev = [...state.prev, state.after ?? ''].slice(-MAX_TRAIL);
  return viewHref(schema, state, { after: nextCursor, prev });
}

export function prevPageHref(schema: ViewSchema, state: ViewState): string | null {
  if (!state.after) return null;
  const back = state.prev.at(-1);
  if (back === undefined) return viewHref(schema, state, { after: null, prev: [] }); // trail was cut
  return viewHref(schema, state, { after: back || null, prev: state.prev.slice(0, -1) });
}

/**
 * The canonical URL when the request came from a GET form (empty parameters, repeated keys such
 * as `cols=a&cols=b`); null when the URL is already canonical. Never when values were ignored,
 * so the "Ignored" note stays visible.
 */
export function canonicalHref(schema: ViewSchema, raw: RawParams, state: ViewState): string | null {
  if (state.ignored.length) return null;
  const canonical = viewParams(schema, state);
  const want = new Map<string, string[]>();
  for (const [k, v] of canonical) want.set(k, [...(want.get(k) ?? []), v]);
  // A URL without `view=` that equals a system view is fine as it is (the tab is found from it).
  if (raw.view === undefined) want.delete('view');
  const have = new Map<string, string[]>();
  for (const [k, v] of Object.entries(raw)) if (v !== undefined) have.set(k, Array.isArray(v) ? v : [v]);
  // Same keys with the same values (repeated `prev` compared in order: a keyset page 3+ URL is
  // canonical as it is; anything else — empty fields, repeated keys, defaults spelled out, a stale
  // `view=` — is not).
  const same =
    want.size === have.size &&
    [...want].every(([k, v]) => {
      const h = have.get(k);
      return !!h && h.length === v.length && h.every((x, i) => x === v[i]);
    });
  return same ? null : viewHref(schema, state);
}

/** Whether row numbers are exact: the page trail still reaches page 1 (or there is no cursor). */
export const rowsNumbered = (state: ViewState) => !state.after || state.prev[0] === '';

/** Index of the first row on this page (0-based). Exact while the trail reaches page 1. */
export const pageOffset = (state: ViewState) =>
  state.offset > 0 ? state.offset : state.after ? state.prev.length * state.limit : 0;

/** Offset paging: the next page, or null when this is the last one. */
export function nextOffsetHref(schema: ViewSchema, state: ViewState, shown: number, total: number | null) {
  const end = state.offset + shown;
  const more = total === null ? shown === state.limit : end < total;
  return more && end <= MAX_OFFSET ? viewHref(schema, state, { offset: end }) : null;
}

export function prevOffsetHref(schema: ViewSchema, state: ViewState) {
  return state.offset > 0
    ? viewHref(schema, state, { offset: Math.max(0, state.offset - state.limit) })
    : null;
}

/** Filter state with one value removed (or the whole filter when `value` is omitted). */
export function withoutFilter(state: ViewState, param: string, value?: string): Record<string, string[]> {
  const f = { ...state.filters };
  const rest = value === undefined ? [] : (f[param] ?? []).filter((v) => v !== value);
  if (rest.length) f[param] = rest;
  else delete f[param];
  return f;
}

/** The sort a column header click applies: its key ascending, or descending if already ascending. */
export function toggledSort(state: ViewState, key: string): string {
  return state.sort === key ? `-${key}` : key;
}

/** `aria-sort` of a column header for its sort key (`natural: 'desc'` keys sort highest first). */
export function ariaSort(
  state: ViewState,
  key: string | undefined,
  natural: 'asc' | 'desc' = 'asc',
): 'ascending' | 'descending' | undefined {
  if (!key) return undefined;
  const bare = natural === 'desc' ? 'descending' : 'ascending';
  const flipped = natural === 'desc' ? 'ascending' : 'descending';
  if (state.sort === key) return bare;
  if (state.sort === `-${key}`) return flipped;
  return undefined;
}

/** Menu label and arrow of a sort (key or `-key`), honouring the key's natural direction. */
export function sortLabel(spec: SortSpec, sort: string): { text: string; arrow: '↑' | '↓' } {
  const reversed = sort.startsWith('-');
  const desc = spec.natural === 'desc' ? !reversed : reversed;
  const text = spec.labels
    ? spec.labels[reversed ? 1 : 0]
    : `${spec.label} ${desc ? '↓ descending' : '↑ ascending'}`;
  return { text, arrow: desc ? '↓' : '↑' };
}

/**
 * The list API query for a state: filters joined with commas (the API ORs them), sort, limit,
 * cursor, and `count=none` while paging with a cursor (per the list contract; the first page
 * leaves `count` to the API, which skips it for live semi-join filters).
 */
export function apiQuery(schema: ViewSchema, state: ViewState): Record<string, string | number> {
  const q: Record<string, string | number> = { limit: state.limit };
  if (state.sort) q.sort = state.sort;
  if (state.offset > 0) q.offset = state.offset;
  if (schema.summaryView) q.view = 'summary';
  if (state.q) q.q = state.q;
  for (const spec of schema.filters) {
    const v = state.filters[spec.param];
    if (v?.length) q[spec.param] = v.join(',');
  }
  if (state.after) {
    q[schema.cursorParam ?? 'after'] = state.after;
    if (schema.countParam !== false) q.count = 'none';
  }
  return q;
}

/**
 * Hidden inputs that keep the rest of the view when a GET form edits one part of it (search,
 * filters or columns). `omit` names what the form itself submits.
 */
export function hiddenFields(
  schema: ViewSchema,
  state: ViewState,
  omit: Array<'q' | 'filters' | 'cols' | 'sort' | 'density'>,
): [string, string][] {
  const out: [string, string][] = [];
  const p = viewParams(schema, { ...state, after: null, prev: [], offset: 0 });
  const filterParams = new Set(schema.filters.map((f) => f.param));
  for (const [k, v] of p) {
    if (omit.includes('filters') && filterParams.has(k)) continue;
    if (omit.includes(k as 'q')) continue;
    out.push([k, v]);
  }
  return out;
}
