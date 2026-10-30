import { describe, expect, it } from 'vitest';
import {
  apiQuery,
  canonicalHref,
  rowsNumbered,
  sortLabel,
  ariaSort,
  hiddenFields,
  isModified,
  MAX_TRAIL,
  nextOffsetHref,
  nextPageHref,
  pageOffset,
  parseView,
  prevOffsetHref,
  prevPageHref,
  systemViewHref,
  toggledSort,
  viewHref,
  viewParams,
  type ViewSchema,
  visibleColumns,
  withoutFilter,
} from './views';

const schema: ViewSchema = {
  path: '/jobs',
  summaryView: true,
  defaultSort: '-lastSeenAt',
  sorts: [
    { key: 'lastSeenAt', label: 'Last seen' },
    { key: 'title', label: 'Title' },
  ],
  filters: [
    {
      param: 'workModel',
      label: 'Work model',
      kind: 'enum',
      values: ['remote', 'hybrid', 'onsite', 'unclear'],
    },
    { param: 'hasConflicts', label: 'Conflicts', kind: 'choice', values: ['true', 'false'] },
    { param: 'country', label: 'Country', kind: 'codes', pattern: /^[A-Z]{2}$/, transform: 'upper' },
    { param: 'currency', label: 'Currency', kind: 'codes', pattern: /^[A-Z]{3}$/, transform: 'upper' },
    { param: 'minAnnual', label: 'Min annual', kind: 'number' },
    { param: 'lastSeenAfter', label: 'Seen after', kind: 'date' },
  ],
  crossCheck: (f) =>
    f.minAnnual && (f.currency?.length ?? 0) !== 1
      ? [{ param: 'minAnnual', reason: 'needs one currency' }]
      : [],
  columns: [
    { key: 'title', identity: true },
    { key: 'company', defaultVisible: true },
    { key: 'workModel', defaultVisible: true },
    { key: 'seniority' },
  ],
  views: [
    { id: 'all', label: 'All' },
    { id: 'remote', label: 'Remote', filters: { workModel: ['remote'] } },
    { id: 'recent', label: 'Recent', sort: 'title' },
  ],
};

const qs = (href: string) => new URLSearchParams(href.split('?')[1] ?? '');

describe('parseView', () => {
  it('keeps contract values, drops and reports the rest (a hand-edited URL never 400s)', () => {
    const s = parseView(schema, {
      workModel: 'remote,nonsense',
      hasConflicts: ['true', 'false'],
      country: 'gb, IE ,usa',
      lastSeenAfter: '2026-13-45',
      sort: 'salary',
      bogus: 'x',
    });
    expect(s.filters).toEqual({ workModel: ['remote'], hasConflicts: ['true'], country: ['GB', 'IE'] });
    expect(s.sort).toBe('-lastSeenAt');
    expect(s.ignored.map((i) => `${i.param}=${i.value}`)).toEqual([
      'bogus=x', // unknown parameter (a typo is reported, not silently dropped)
      'workModel=nonsense',
      'hasConflicts=false',
      'country=usa',
      'lastSeenAfter=2026-13-45',
      'sort=salary',
    ]);
  });

  it('accepts repeated keys and comma lists alike, de-duplicated', () => {
    expect(parseView(schema, { workModel: ['remote,hybrid', 'remote'] }).filters.workModel).toEqual([
      'remote',
      'hybrid',
    ]);
  });

  it('applies cross-parameter rules the API enforces (minAnnual needs exactly one currency)', () => {
    expect(parseView(schema, { minAnnual: '50000' }).filters.minAnnual).toBeUndefined();
    expect(parseView(schema, { minAnnual: '50000', currency: 'gbp' }).filters).toEqual({
      minAnnual: ['50000'],
      currency: ['GBP'],
    });
  });

  it('finds the system view a URL equals, and marks a changed view as modified', () => {
    const remote = parseView(schema, { workModel: 'remote' });
    expect(remote.view).toBe('remote');
    expect(isModified(schema, remote)).toBe(false);
    // Still containing the view's filter: the view, modified.
    const changed = parseView(schema, { view: 'remote', workModel: 'remote,hybrid' });
    expect(changed.view).toBe('remote');
    expect(isModified(schema, changed)).toBe(true);
    // Its defining filter removed: no longer that view (back to the base view, modified).
    const dropped = parseView(schema, { view: 'remote', workModel: 'hybrid' });
    expect(dropped.view).toBe('all');
    expect(isModified(schema, dropped)).toBe(true);
    expect(parseView(schema, { view: 'remote' }).view).toBe('all');
    expect(parseView(schema, { sort: 'title' }).view).toBe('recent');
    expect(parseView(schema, {}).view).toBe('all');
  });

  it('rejects impossible calendar dates', () => {
    expect(parseView(schema, { lastSeenAfter: '2026-02-31' }).filters.lastSeenAfter).toBeUndefined();
    expect(parseView(schema, { lastSeenAfter: '2026-02-28' }).filters.lastSeenAfter).toEqual(['2026-02-28']);
    expect(parseView(schema, { lastSeenAfter: '2024-02-29' }).filters.lastSeenAfter).toEqual(['2024-02-29']);
  });

  it('turns GET-form URLs (empty fields, repeated keys) into the canonical one, unless values were ignored', () => {
    const raw = {
      q: '',
      hasConflicts: '',
      workModel: ['remote', 'hybrid'],
      cols: ['title', 'company', 'seniority'],
    };
    expect(canonicalHref(schema, raw, parseView(schema, raw))).toBe(
      '/jobs?workModel=remote%2Chybrid&cols=company%2Cseniority',
    );
    expect(
      canonicalHref(schema, { workModel: 'remote' }, parseView(schema, { workModel: 'remote' })),
    ).toBeNull();
    // A stale view= (its filters gone) is dropped from the URL.
    expect(canonicalHref(schema, { view: 'remote' }, parseView(schema, { view: 'remote' }))).toBe('/jobs');
    const bad = { workModel: ['remote', 'moon'] };
    expect(canonicalHref(schema, bad, parseView(schema, bad))).toBeNull(); // keeps the Ignored note
    // Canonical URLs are fixed points.
    const href = canonicalHref(schema, raw, parseView(schema, raw))!;
    const again = Object.fromEntries(new URLSearchParams(href.split('?')[1]));
    expect(canonicalHref(schema, again, parseView(schema, again))).toBeNull();
  });

  it('numbers rows only while the cursor trail reaches page 1', () => {
    expect(rowsNumbered(parseView(schema, { after: 'c3', prev: ['', 'c2'] }))).toBe(true);
    expect(rowsNumbered(parseView(schema, { after: 'c30', prev: ['c9', 'c10'] }))).toBe(false);
    expect(rowsNumbered(parseView(schema, {}))).toBe(true);
  });

  it('accepts only the offered page sizes and reports others', () => {
    expect(parseView(schema, { limit: '10' }).limit).toBe(10);
    expect(parseView(schema, { limit: '7' }).limit).toBe(50);
    expect(parseView(schema, { limit: '7' }).ignored.map((i) => i.param)).toEqual(['limit']);
    expect(viewParams(schema, parseView(schema, { limit: '25' })).get('limit')).toBe('25');
  });

  it('ignores a page trail without a cursor and caps cursor length', () => {
    expect(parseView(schema, { prev: ['a', 'b'] }).prev).toEqual([]);
    expect(parseView(schema, { after: 'x'.repeat(2001) }).after).toBeNull();
  });
});

describe('columns', () => {
  it('shows the identity column first, then the defaults or the URL choice', () => {
    expect(visibleColumns(schema, { cols: null })).toEqual(['title', 'company', 'workModel']);
    expect(visibleColumns(schema, parseView(schema, { cols: 'seniority,company,nope' }))).toEqual([
      'title',
      'company',
      'seniority',
    ]);
  });

  it('round-trips "identity only" and leaves default columns out of the URL', () => {
    const only = parseView(schema, { cols: 'title' });
    expect(visibleColumns(schema, only)).toEqual(['title']);
    expect(viewParams(schema, only).get('cols')).toBe('title');
    expect(viewParams(schema, parseView(schema, { cols: 'company,workModel' })).has('cols')).toBe(false);
  });
});

describe("first view with another view's filters", () => {
  it('stays on the first tab (modified) and round-trips with view= kept', () => {
    const s = parseView(schema, { view: 'all', workModel: 'remote' });
    expect(s.view).toBe('all');
    expect(isModified(schema, s)).toBe(true);
    const href = viewHref(schema, s);
    expect(href).toBe('/jobs?view=all&workModel=remote');
    expect(parseView(schema, Object.fromEntries(qs(href))).view).toBe('all');
    expect(canonicalHref(schema, { view: 'all', workModel: 'remote' }, s)).toBeNull();
    // Without view=, the same query is the Remote tab.
    expect(parseView(schema, { workModel: 'remote' }).view).toBe('remote');
  });
});

describe('hrefs', () => {
  const base = parseView(schema, { workModel: 'remote,hybrid', sort: 'title', density: 'comfortable' });

  it('serialises in a stable order without defaults and parses back to the same state', () => {
    const href = viewHref(schema, base);
    expect(href).toBe('/jobs?workModel=remote%2Chybrid&sort=title&density=comfortable');
    const again = parseView(schema, Object.fromEntries(qs(href)));
    expect(viewHref(schema, again)).toBe(href);
  });

  it('any change to what is listed drops the page cursor (a cursor is bound to its query)', () => {
    const paged = { ...base, after: 'c2', prev: [''] };
    for (const patch of [{ sort: '-title' }, { q: 'eng' }, { filters: {} }, { view: 'remote' }]) {
      const p = qs(viewHref(schema, paged, patch));
      expect(p.has('after')).toBe(false);
      expect(p.has('prev')).toBe(false);
    }
    // Presentation changes keep the page.
    expect(qs(viewHref(schema, paged, { density: 'compact' })).get('after')).toBe('c2');
  });

  it('keyset next/previous keep a trail of cursors back to the first page', () => {
    const p1 = parseView(schema, {});
    const p2 = parseView(schema, Object.fromEntries(qs(nextPageHref(schema, p1, 'c2')).entries()));
    expect(p2.after).toBe('c2');
    const p2raw = qs(nextPageHref(schema, p1, 'c2'));
    expect(p2raw.getAll('prev')).toEqual(['']);
    const p3params = qs(nextPageHref(schema, { ...p2, prev: [''] }, 'c3'));
    expect(p3params.getAll('prev')).toEqual(['', 'c2']);
    const p3 = parseView(schema, { after: 'c3', prev: ['', 'c2'] });
    expect(pageOffset(p3)).toBe(100);
    expect(qs(prevPageHref(schema, p3)!).get('after')).toBe('c2');
    const back1 = prevPageHref(schema, parseView(schema, { after: 'c2', prev: [''] }))!;
    expect(qs(back1).has('after')).toBe(false);
    expect(prevPageHref(schema, p1)).toBeNull();
  });

  it('caps the trail', () => {
    const long = parseView(schema, { after: 'z', prev: Array.from({ length: 40 }, (_, i) => `c${i}`) });
    expect(long.prev).toHaveLength(MAX_TRAIL);
    expect(qs(nextPageHref(schema, long, 'n')).getAll('prev')).toHaveLength(MAX_TRAIL);
  });

  it('system view links start from the preset but keep columns and density', () => {
    const href = systemViewHref(schema, { ...base, cols: ['title', 'seniority'] }, 'remote');
    expect(href).toBe('/jobs?view=remote&workModel=remote&cols=seniority&density=comfortable');
  });

  it('removes one filter value or the whole filter', () => {
    expect(withoutFilter(base, 'workModel', 'remote')).toEqual({ workModel: ['hybrid'] });
    expect(withoutFilter(base, 'workModel')).toEqual({});
  });

  it('header sort toggles ascending then descending and reports aria-sort', () => {
    expect(toggledSort(base, 'title')).toBe('-title');
    expect(toggledSort({ ...base, sort: '-title' }, 'title')).toBe('title');
    expect(ariaSort(base, 'title')).toBe('ascending');
    expect(ariaSort({ ...base, sort: '-lastSeenAt' }, 'lastSeenAt')).toBe('descending');
    expect(ariaSort(base, 'lastSeenAt')).toBeUndefined();
  });
});

describe('apiQuery', () => {
  it('sends exactly the API parameters: filters joined, sort, summary view, limit — no UI state', () => {
    const s = parseView(schema, {
      view: 'remote',
      workModel: 'remote,hybrid',
      q: ' eng ',
      cols: 'seniority',
      density: 'comfortable',
    });
    expect(apiQuery(schema, s)).toEqual({
      limit: 50,
      sort: '-lastSeenAt',
      view: 'summary',
      q: 'eng',
      workModel: 'remote,hybrid',
    });
  });

  it('pages with the cursor and skips the count (list contract)', () => {
    const s = parseView(schema, { after: 'c2', prev: '' });
    expect(apiQuery(schema, s)).toMatchObject({ after: 'c2', count: 'none' });
    expect(apiQuery(schema, parseView(schema, {}))).not.toHaveProperty('count');
  });

  it('uses the schema cursor name and leaves out count when the list has no total', () => {
    const imports = { ...schema, cursorParam: 'cursor', countParam: false };
    const q = apiQuery(imports, parseView(imports, { after: 'c2', prev: '' }));
    expect(q).toMatchObject({ cursor: 'c2' });
    expect(q).not.toHaveProperty('after');
    expect(q).not.toHaveProperty('count');
  });
});

describe('hiddenFields', () => {
  it('keeps the rest of the view in a GET form that edits one part', () => {
    const s = parseView(schema, { q: 'eng', workModel: 'remote', sort: 'title', after: 'c2', prev: '' });
    expect(hiddenFields(schema, s, ['filters'])).toEqual([
      ['q', 'eng'],
      ['sort', 'title'],
    ]);
    expect(hiddenFields(schema, s, ['q'])).toEqual([
      ['workModel', 'remote'],
      ['sort', 'title'],
    ]);
  });
});

describe('offset paging and filter-dependent default sort (v1 lists, review)', () => {
  const runs: ViewSchema = {
    path: '/runs',
    paging: 'offset',
    defaultSort: '',
    sorts: [],
    filters: [{ param: 'state', label: 'State', kind: 'choice', values: ['FAILED', 'RUNNING'] }],
    columns: [{ key: 'workflow', identity: true }],
    views: [{ id: 'all-runs', label: 'All' }],
  };

  it('pages by offset: parse, next/previous, reset when the query changes, API query', () => {
    const s = parseView(runs, { offset: '50', after: 'ignored', state: 'FAILED' });
    expect(s.offset).toBe(50);
    expect(s.after).toBeNull();
    expect(pageOffset(s)).toBe(50);
    expect(apiQuery(runs, s)).toEqual({ limit: 50, offset: 50, state: 'FAILED' }); // no sort, no count
    expect(nextOffsetHref(runs, s, 50, 120)).toBe('/runs?state=FAILED&offset=100');
    expect(nextOffsetHref(runs, s, 50, 100)).toBeNull();
    expect(nextOffsetHref(runs, s, 50, null)).toBe('/runs?state=FAILED&offset=100'); // full page, no total
    expect(prevOffsetHref(runs, s)).toBe('/runs?state=FAILED');
    expect(prevOffsetHref(runs, parseView(runs, {}))).toBeNull();
    expect(viewHref(runs, s, { filters: {} })).toBe('/runs');
    expect(parseView(runs, { offset: '-5' }).offset).toBe(0);
  });

  const review: ViewSchema = {
    path: '/review',
    defaultSort: 'priority',
    defaultSortFor: (f) => (f.status?.[0] === 'resolved' ? '-updatedAt' : undefined),
    sorts: [
      { key: 'priority', label: 'Priority' },
      { key: 'updatedAt', label: 'Updated' },
    ],
    filters: [{ param: 'status', label: 'Status', kind: 'choice', values: ['open', 'resolved', 'all'] }],
    columns: [{ key: 'subject', identity: true }],
    views: [
      { id: 'open', label: 'Open' },
      { id: 'resolved', label: 'Resolved', filters: { status: ['resolved'] } },
    ],
  };

  it("uses the API's default sort for the filters and leaves it out of the URL", () => {
    const resolved = parseView(review, { status: 'resolved' });
    expect(resolved.sort).toBe('-updatedAt');
    expect(resolved.view).toBe('resolved');
    expect(isModified(review, resolved)).toBe(false);
    expect(viewHref(review, resolved)).toBe('/review?view=resolved&status=resolved');
    expect(parseView(review, {}).sort).toBe('priority');
    // An explicit sort different from the default is kept.
    expect(viewHref(review, parseView(review, { status: 'resolved', sort: 'priority' }))).toBe(
      '/review?status=resolved&sort=priority',
    );
  });
});

describe('review and runs specifics (UX3f)', () => {
  const review: ViewSchema = {
    path: '/review',
    search: false,
    defaultSort: 'priority',
    defaultSortFor: (f) => (f.status?.[0] === 'resolved' ? '-updatedAt' : undefined),
    sorts: [
      {
        key: 'priority',
        label: 'Priority',
        natural: 'desc',
        labels: ['Priority: highest first', 'Priority: lowest first'],
      },
      { key: 'updatedAt', label: 'Updated' },
    ],
    filters: [
      { param: 'status', label: 'Status', kind: 'choice', values: ['open', 'resolved', 'all'] },
      { param: 'severity', label: 'Severity', kind: 'enum', values: ['high', 'low'] },
    ],
    columns: [
      { key: 'subject', identity: true },
      { key: 'severity', defaultVisible: true },
      { key: 'state' },
    ],
    views: [
      { id: 'open', label: 'Open' },
      { id: 'resolved', label: 'Resolved', filters: { status: ['resolved'] }, cols: ['state'] },
    ],
  };
  const runs: ViewSchema = {
    path: '/runs',
    paging: 'offset',
    search: false,
    defaultSort: '',
    sorts: [],
    filters: [
      { param: 'all', label: 'Child runs', kind: 'choice', values: ['true', 'false'], apiDefault: 'false' },
      { param: 'workflowKey', label: 'Workflow', kind: 'codes', pattern: /^[a-z.]+$/, max: 1 },
    ],
    columns: [{ key: 'workflow', identity: true }],
    views: [{ id: 'all-runs', label: 'All' }],
  };

  it('priority sorts highest first: label, arrow and aria-sort say descending', () => {
    const spec = review.sorts[0]!;
    expect(sortLabel(spec, 'priority')).toEqual({ text: 'Priority: highest first', arrow: '↓' });
    expect(sortLabel(spec, '-priority')).toEqual({ text: 'Priority: lowest first', arrow: '↑' });
    const s = parseView(review, {});
    expect(ariaSort(s, 'priority', 'desc')).toBe('descending');
    expect(ariaSort(parseView(review, { sort: '-priority' }), 'priority', 'desc')).toBe('ascending');
    // Keys without a natural direction keep the plain labels.
    expect(sortLabel(review.sorts[1]!, '-updatedAt')).toEqual({ text: 'Updated ↓ descending', arrow: '↓' });
  });

  it('ignores and reports q on lists without search, and never sends it', () => {
    const s = parseView(review, { q: 'acme' });
    expect(s.q).toBe('');
    expect(s.ignored).toEqual([{ param: 'q', value: 'acme', reason: 'this list has no search' }]);
    expect(apiQuery(review, s)).not.toHaveProperty('q');
    expect(parseView(runs, { q: 'x' }).ignored.map((i) => i.param)).toEqual(['q']);
  });

  it('a default sort follows the filters when a chip is removed or filters are cleared', () => {
    const resolved = parseView(review, { status: 'resolved' });
    expect(resolved.sort).toBe('-updatedAt');
    // Removing the status chip returns to the open queue's default (priority), not -updatedAt.
    expect(viewHref(review, resolved, { filters: withoutFilter(resolved, 'status') })).toBe('/review');
    expect(viewHref(review, resolved, { filters: {} })).toBe('/review');
    // An explicitly chosen sort survives a filter change.
    const chosen = parseView(review, { status: 'resolved', sort: 'updatedAt' });
    expect(viewHref(review, chosen, { filters: {} })).toBe('/review?sort=updatedAt');
  });

  it('single-value code filters report extra values', () => {
    const s = parseView(runs, { workflowKey: 'a.b,c.d' });
    expect(s.filters.workflowKey).toEqual(['a.b']);
    expect(s.ignored).toEqual([{ param: 'workflowKey', value: 'c.d', reason: 'only one value allowed' }]);
  });

  it('accepts only decimal offsets within the API range', () => {
    expect(parseView(runs, { offset: '100000' }).offset).toBe(100_000);
    for (const bad of ['200000', '0x10', '1e3', '2.5', '-5', ' 7'])
      expect(parseView(runs, { offset: bad }).ignored.map((i) => i.param)).toEqual(['offset']);
    expect(parseView(runs, { offset: '0x10' }).offset).toBe(0);
  });

  it('the API default of a choice filter is not a modification (/runs?all=false is /runs)', () => {
    const s = parseView(runs, { all: 'false' });
    expect(s.filters.all ?? []).toEqual([]);
    expect(s.ignored).toEqual([]);
    expect(isModified(runs, s)).toBe(false);
    expect(canonicalHref(runs, { all: 'false' }, s)).toBe('/runs');
  });

  it('a keyset page 3+ URL is canonical (the prev trail is compared in order, not redirected)', () => {
    const raw = { after: 'c3', prev: ['', 'c2'] };
    const s = parseView(review, raw);
    expect(s.prev).toEqual(['', 'c2']);
    expect(canonicalHref(review, raw, s)).toBeNull();
    // A default spelled out (limit=50) is still canonicalised.
    expect(canonicalHref(review, { after: 'c3', prev: ['', 'c2'], limit: '50' }, s)).not.toBeNull();
  });

  it('views can set their own default columns; the URL choice still wins', () => {
    expect(visibleColumns(review, parseView(review, {}))).toEqual(['subject', 'severity']);
    expect(visibleColumns(review, parseView(review, { status: 'resolved' }))).toEqual(['subject', 'state']);
    expect(viewParams(review, parseView(review, { status: 'resolved' })).has('cols')).toBe(false);
    expect(visibleColumns(review, parseView(review, { status: 'resolved', cols: 'severity' }))).toEqual([
      'subject',
      'severity',
    ]);
  });
});

describe('unknown parameters and single choices (UX3f re-review)', () => {
  const runs: ViewSchema = {
    path: '/runs',
    paging: 'offset',
    search: false,
    defaultSort: '',
    sorts: [],
    filters: [
      { param: 'state', label: 'State', kind: 'choice', values: ['FAILED', 'RUNNING'] },
      { param: 'all', label: 'Child runs', kind: 'choice', values: ['true', 'false'], apiDefault: 'false' },
    ],
    columns: [{ key: 'workflow', identity: true }],
    views: [{ id: 'all-runs', label: 'All' }],
  };

  it('reports a mistyped parameter instead of redirecting it away', () => {
    const raw = { stat: 'FAILED' };
    const s = parseView(runs, raw);
    expect(s.ignored).toEqual([{ param: 'stat', value: 'FAILED', reason: 'not a parameter of this list' }]);
    expect(canonicalHref(runs, raw, s)).toBeNull(); // stays, so the note is visible
    expect(apiQuery(runs, s)).not.toHaveProperty('stat');
  });

  it("reports the other paging mode's parameters", () => {
    expect(parseView(runs, { after: 'c2' }).ignored.map((i) => i.param)).toEqual(['after']);
    expect(parseView(schema, { offset: '10' }).ignored.map((i) => i.param)).toEqual(['offset']);
  });

  it('a single-value choice reports extra values, the API default included', () => {
    const s = parseView(runs, { all: 'false,true' });
    expect(s.filters.all).toBeUndefined();
    expect(s.ignored).toEqual([{ param: 'all', value: 'true', reason: 'only one value allowed' }]);
    expect(parseView(runs, { all: 'true,false' }).filters.all).toEqual(['true']);
  });
});
