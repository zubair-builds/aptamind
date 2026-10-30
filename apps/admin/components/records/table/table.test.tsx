// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobSummary, ReviewListItem, SummaryFact, WorkflowRun } from '@/lib/types';
import { sourceNames } from '@/components/links';
import { canonicalHref, parseView, visibleColumns } from '@/lib/views';
import { companiesObject } from '../registry/companies';
import { jobsObject } from '../registry/jobs';
import { reviewObject } from '../registry/review';
import { runsObject as makeRuns } from '../registry/runs';
import { sourcesObject } from '../registry/sources';
import { Pager } from './Pager';
import { RecordTable } from './RecordTable';
import { TableKeys } from './TableKeys';
import { ViewBar } from './ViewBar';

const runsObject = makeRuns(sourceNames([{ _id: 'src_1', name: 'Acme careers' }]));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/jobs', useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);

const sf = <T,>(value: T | null, over: Partial<SummaryFact<T>> = {}): SummaryFact<T> => ({
  value,
  status: value === null ? 'unknown' : 'known',
  confidence: { level: value === null ? 'unknown' : 'high' },
  basis: null,
  alternates: 0,
  ...over,
});

const job = (id: string, over: Partial<JobSummary> = {}): JobSummary => ({
  _id: id,
  companyId: 'cmp_1',
  companyName: 'Acme Ltd',
  status: 'active',
  identity: { title: sf(`Engineer ${id}`), seniority: sf('senior') },
  employment: { employmentType: sf('full_time') },
  geography: {
    listedLocations: ['London, GB', 'Remote'],
    locationCount: 3,
    countries: ['GB'],
    workModel: sf('remote'),
    remoteScope: sf({
      type: 'country',
      countries: ['GB'],
      regions: [],
      excludedCountries: [],
      excludedRegions: [],
      timezone: null,
    }),
  },
  immigration: {
    sponsorship: sf(
      {
        status: 'company_capable',
        roleStatement: 'none',
        companyCapability: 'licensed',
        capabilityCountries: ['GB'],
      },
      { status: 'unknown', confidence: { level: 'unknown' } },
    ),
    authorization: sf({ required: null, countries: [], qualifiers: [] }, { status: 'unknown' }),
    relocation: sf('unclear', { status: 'unknown' }),
  },
  compensation: sf({
    status: 'parsed',
    min: 60000,
    max: 80000,
    currency: 'GBP',
    period: 'year',
    basis: 'base',
    annualized: { min: 60000, max: 80000 },
    warnings: [],
    originalText: '£60k–£80k',
  }),
  postingUrl: null,
  lifecycle: {
    state: 'VERIFIED_LIVE',
    firstSeenAt: '2026-09-20T10:00:00Z',
    lastSeenAt: '2026-09-29T10:00:00Z',
  },
  verification: {},
  flags: [],
  quality: { conflictFields: ['geography.workModel'], sourceCount: 2 },
  openReviewCount: 1,
  providers: ['greenhouse'],
  rev: 3,
  contentHash: 'h',
  updatedAt: '2026-09-29T10:00:00Z',
  ...over,
});

const rows = [job('job_1'), job('job_2'), job('job_3')];

describe('RecordTable', () => {
  const renderTable = (params: Record<string, string> = {}) =>
    render(
      <RecordTable
        def={jobsObject}
        state={parseView(jobsObject, params)}
        rows={rows}
        tableId="jobs-table"
        caption="Jobs, rows 1–3 of 3"
      />,
    );

  it('renders a captioned, scrollable region with sortable headers and aria-sort', () => {
    renderTable();
    const region = screen.getByRole('region', { name: 'Jobs table' });
    expect(region.tabIndex).toBe(0);
    const table = within(region).getByRole('table', {
      name: /^Jobs, rows 1–3 of 3\. Tab moves between rows/,
    });
    const lastSeen = within(table).getByRole('columnheader', { name: /Last seen/ });
    expect(lastSeen.getAttribute('aria-sort')).toBe('descending'); // API default -lastSeenAt
    expect(within(lastSeen).getByRole('link').getAttribute('href')).toBe('/jobs?sort=lastSeenAt');
    const title = within(table).getByRole('columnheader', { name: 'Title' });
    expect(title.getAttribute('aria-sort')).toBeNull();
    expect(within(title).getByRole('link').getAttribute('href')).toBe('/jobs?sort=title');
    // Unsortable columns are plain text.
    expect(
      within(within(table).getByRole('columnheader', { name: 'Company' })).queryByRole('link'),
    ).toBeNull();
  });

  it('shows at most 8 default columns (design system §3)', () => {
    for (const def of [jobsObject, companiesObject, sourcesObject, reviewObject, runsObject])
      expect(def.columns.filter((c) => c.identity || c.defaultVisible).length).toBeLessThanOrEqual(8);
  });

  it('each row: a name link (row header), a preview, company names (not ids), API values', () => {
    renderTable();
    const first = screen.getAllByRole('row')[1]!;
    const name = within(first).getByRole('rowheader');
    const link = within(name).getByRole('link', { name: 'Engineer job_1' });
    expect(link.getAttribute('href')).toBe('/jobs/job_1');
    expect(link.hasAttribute('data-row-link')).toBe(true);
    expect(within(first).getByRole('link', { name: 'Acme Ltd' }).getAttribute('href')).toBe(
      '/companies/cmp_1',
    );
    expect(first.textContent).not.toContain('cmp_1');
    expect(first.textContent).toContain('London, GB · Remote +1');
    // Company licence is never shown as the role sponsoring; unknown stays Unknown.
    expect(first.textContent).toContain('Unknown');
    expect(first.textContent).not.toMatch(/Role offers sponsorship|sponsors: yes/i);

    fireEvent.click(within(name).getByRole('button', { name: 'Preview Engineer job_1' }));
    const peek = screen.getByRole('dialog', { name: 'Preview: Engineer job_1' });
    expect(within(peek).getByRole('link', { name: 'Open job record →' }).getAttribute('href')).toBe(
      '/jobs/job_1',
    );
    expect(peek.textContent).toContain('1 field with other values'); // known fact: neutral, not a disagreement
    expect(peek.textContent).toContain('Sponsorship');
    expect(peek.textContent).toContain('Unknown');
  });

  it('shows only the URL-chosen columns and the density', () => {
    renderTable({ cols: 'seniority', density: 'comfortable' });
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Title', 'Seniority']);
    expect(screen.getByRole('table').getAttribute('data-density')).toBe('comfortable');
  });
});

describe('ViewBar', () => {
  const renderBar = (params: Record<string, string | string[]>) =>
    render(
      <ViewBar def={jobsObject} state={parseView(jobsObject, params)} rows={rows} searchId="jobs-search" />,
    );

  it('marks the active system view and links every view with its preset', () => {
    renderBar({ workModel: 'remote' });
    const nav = screen.getByRole('navigation', { name: 'Jobs views' });
    expect(within(nav).getByRole('link', { name: 'Remote' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Open reviews' }).getAttribute('href')).toBe(
      '/jobs?view=reviews&hasOpenReviews=true',
    );
    expect(screen.queryByRole('link', { name: 'Reset view' })).toBeNull();
  });

  it('chips name each filter (company by name) and remove it; a changed view can be reset', () => {
    renderBar({ view: 'remote', workModel: 'remote,hybrid', companyId: 'cmp_1', q: 'eng' });
    const chips = screen.getByRole('group', { name: 'Active filters' });
    expect(chips.textContent).toContain('Work model: Remote, Hybrid'); // sentence case
    expect(chips.textContent).toContain('Company: Acme Ltd');
    expect(chips.textContent).toContain('Search: “eng”');
    expect(within(chips).getByRole('link', { name: 'Remove filter Company' }).getAttribute('href')).toBe(
      '/jobs?view=remote&q=eng&workModel=remote%2Chybrid',
    );
    expect(within(chips).getByRole('link', { name: 'Reset view' }).getAttribute('href')).toBe(
      '/jobs?view=remote&workModel=remote',
    );
  });

  it('the filter form offers exactly the contract values and keeps the rest of the view', () => {
    renderBar({ sort: 'title', sponsorship: 'company_capable' });
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const panel = screen.getByRole('dialog', { name: 'Filter jobs' });
    const sponsorship = within(panel).getByRole('group', { name: 'Sponsorship status' });
    const boxes = within(sponsorship).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.value)).toEqual([
      'explicit_yes',
      'explicit_no',
      'company_capable',
      'historical_evidence',
      'unclear',
    ]);
    expect(boxes.find((b) => b.value === 'company_capable')!.checked).toBe(true);
    expect(sponsorship.textContent).toContain('Company capable (licence; role silent)');
    const hidden = [...panel.querySelectorAll<HTMLInputElement>('input[type=hidden]')].map(
      (i) => `${i.name}=${i.value}`,
    );
    expect(hidden).toEqual(['sort=title']);
    expect(panel.textContent).toContain("Enum filters match a fact's value whatever its status");
  });

  it('reports URL values the API would reject instead of sending them', () => {
    renderBar({ workModel: 'moon', sort: 'salary' });
    expect(screen.getByRole('note').textContent).toContain('workModel=moon');
    expect(screen.getByRole('note').textContent).toContain('sort=salary');
  });

  it('the column chooser always submits the identity column', () => {
    renderBar({});
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = screen.getByRole('dialog', { name: 'Columns' });
    const hidden = panel.querySelector<HTMLInputElement>('input[type=hidden][name=cols]');
    expect(hidden?.value).toBe('title');
    expect((within(panel).getByRole('checkbox', { name: 'Company' }) as HTMLInputElement).checked).toBe(true);
    expect((within(panel).getByRole('checkbox', { name: 'Seniority' }) as HTMLInputElement).checked).toBe(
      false,
    );
  });
});

describe('Pager', () => {
  it('on page 2, First page is disabled (it is the same link as Previous)', () => {
    render(
      <Pager
        def={jobsObject}
        state={parseView(jobsObject, { after: 'c2', prev: '' })}
        shown={50}
        total={null}
        nextCursor="c3"
      />,
    );
    expect(screen.queryByRole('link', { name: 'First page' })).toBeNull();
    expect(screen.getByText('First page').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('link', { name: '← Previous' }).getAttribute('href')).toBe('/jobs');
    cleanup();
    render(
      <Pager
        def={jobsObject}
        state={parseView(jobsObject, { after: 'c3', prev: ['', 'c2'] })}
        shown={50}
        total={null}
        nextCursor={null}
      />,
    );
    expect(screen.getByRole('link', { name: 'First page' }).getAttribute('href')).toBe('/jobs');
  });

  it('shows the range with a total, keyset links and no count while paging', () => {
    const { container, unmount } = render(
      <Pager def={jobsObject} state={parseView(jobsObject, {})} shown={50} total={1234} nextCursor="c2" />,
    );
    expect(container.textContent).toContain('1–50 of 1,234');
    expect(screen.getByRole('link', { name: 'Next →' }).getAttribute('href')).toBe('/jobs?after=c2&prev=');
    expect(screen.queryByRole('link', { name: '← Previous' })).toBeNull();
    unmount();
    render(
      <Pager
        def={jobsObject}
        state={parseView(jobsObject, { after: 'c2', prev: '' })}
        shown={50}
        total={null}
        nextCursor={null}
      />,
    );
    expect(screen.getByRole('navigation', { name: 'Pagination' }).textContent).toContain('51–100');
    expect(screen.getByRole('link', { name: '← Previous' }).getAttribute('href')).toBe('/jobs');
    expect(screen.queryByRole('link', { name: 'Next →' })).toBeNull();
  });
});

describe('TableKeys', () => {
  it('j/k move between row links, arrows inside the table, / focuses search', () => {
    render(
      <>
        <input id="jobs-search" />
        <RecordTable
          def={jobsObject}
          state={parseView(jobsObject, {})}
          rows={rows}
          tableId="jobs-table"
          caption="Jobs"
        />
        <TableKeys tableId="jobs-table" searchId="jobs-search" />
      </>,
    );
    const links = screen.getAllByRole('link').filter((l) => l.hasAttribute('data-row-link'));
    act(() => {
      fireEvent.keyDown(document.body, { key: 'j' });
    });
    expect(document.activeElement).toBe(links[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(links[1]);
    fireEvent.keyDown(document.activeElement!, { key: 'j' });
    fireEvent.keyDown(document.activeElement!, { key: 'j' }); // stays on the last row
    expect(document.activeElement).toBe(links[2]);
    fireEvent.keyDown(document.activeElement!, { key: 'k' });
    expect(document.activeElement).toBe(links[1]);
    fireEvent.keyDown(document.activeElement!, { key: '/' });
    expect(document.activeElement).toBe(document.getElementById('jobs-search'));
    // Typing in the search box is never a shortcut.
    fireEvent.keyDown(document.activeElement!, { key: 'j' });
    expect(document.activeElement).toBe(document.getElementById('jobs-search'));
  });
});

describe('UX3 review follow-ups', () => {
  it('one Tab stop per row; Space opens the row preview; keys inside a layer are ignored', () => {
    render(
      <>
        <input id="jobs-search" />
        <RecordTable
          def={jobsObject}
          state={parseView(jobsObject, {})}
          rows={rows}
          tableId="jobs-table"
          caption="Jobs"
        />
        <TableKeys tableId="jobs-table" searchId="jobs-search" />
      </>,
    );
    const firstRow = screen.getAllByRole('row')[1]!;
    const tabbable = [...firstRow.querySelectorAll<HTMLElement>('a[href], button')].filter(
      (el) => el.tabIndex >= 0,
    );
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]!.hasAttribute('data-row-link')).toBe(true);
    act(() => tabbable[0]!.focus());
    fireEvent.keyDown(tabbable[0]!, { key: ' ' });
    const peek = screen.getByRole('dialog', { name: 'Preview: Engineer job_1' });
    // Inside the preview, j is the preview's key, not the table's.
    const focusedBefore = document.activeElement;
    fireEvent.keyDown(document.activeElement!, { key: 'j' });
    expect(document.activeElement).toBe(focusedBefore);
    expect(within(peek).getByRole('link', { name: 'Acme Ltd' }).getAttribute('href')).toBe(
      '/companies/cmp_1',
    );
  });

  it('a view whose defining filter was removed is no longer current; a changed one is marked', () => {
    render(
      <ViewBar def={jobsObject} state={parseView(jobsObject, { view: 'remote' })} rows={[]} searchId="s" />,
    );
    const nav = screen.getByRole('navigation', { name: 'Jobs views' });
    expect(within(nav).getByRole('link', { name: 'Remote' }).getAttribute('aria-current')).toBeNull();
    expect(within(nav).getByRole('link', { name: 'All jobs' }).getAttribute('aria-current')).toBe('page');
    cleanup();
    render(
      <ViewBar
        def={jobsObject}
        state={parseView(jobsObject, { view: 'remote', workModel: 'remote', state: 'CLOSED' })}
        rows={[]}
        searchId="s"
      />,
    );
    const remote = within(screen.getByRole('navigation', { name: 'Jobs views' })).getByRole('link', {
      name: 'Remote (modified)',
    });
    expect(remote.getAttribute('aria-current')).toBeNull();
    expect(remote.hasAttribute('data-modified')).toBe(true);
  });

  it('a cut-off cell gets its visible text (no screen-reader-only text) as a tooltip', () => {
    const sw = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(500);
    const cw = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
    const r = job('job_t', { compensation: { ...job('x').compensation, alternates: 1 } });
    render(
      <>
        <RecordTable
          def={jobsObject}
          state={parseView(jobsObject, {})}
          rows={[r]}
          tableId="tt"
          caption="Jobs"
        />
        <TableKeys tableId="tt" searchId="none" />
      </>,
    );
    const titles = [...document.querySelectorAll<HTMLElement>('[data-cell][title]')].map((c) => c.title);
    expect(titles).toContain('£60k–£80k / year +1');
    expect(titles.join(' ')).not.toMatch(/other value kept/);
    sw.mockRestore();
    cw.mockRestore();
  });

  it('after a client navigation (new key) the new rows get the same treatment', () => {
    const view = (rs: JobSummary[], key: string) => (
      <>
        <RecordTable
          def={jobsObject}
          state={parseView(jobsObject, {})}
          rows={rs}
          tableId="kt"
          caption="Jobs"
        />
        <TableKeys key={key} tableId="kt" searchId="none" />
      </>
    );
    const { rerender } = render(view([job('job_1')], '/jobs'));
    rerender(view([job('job_7'), job('job_8')], '/jobs?after=c2&prev='));
    for (const row of screen.getAllByRole('row').slice(1)) {
      const tabbable = [...row.querySelectorAll<HTMLElement>('a[href], button')].filter(
        (el) => el.tabIndex >= 0,
      );
      expect(tabbable.map((el) => el.hasAttribute('data-row-link'))).toEqual([true]);
    }
  });

  it('Escape from a preview returns focus to the row link; Back restores the opened row', () => {
    const { unmount } = render(
      <>
        <RecordTable
          def={jobsObject}
          state={parseView(jobsObject, {})}
          rows={rows}
          tableId="ft"
          caption="Jobs"
        />
        <TableKeys tableId="ft" searchId="none" />
      </>,
    );
    const second = screen.getAllByRole('row')[2]!;
    const link = within(second).getByRole('rowheader').querySelector<HTMLElement>('[data-row-link]')!;
    act(() => link.focus());
    fireEvent.keyDown(link, { key: ' ' });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(link);
    const stay = (e: Event) => e.preventDefault(); // keep happy-dom from navigating
    document.addEventListener('click', stay);
    fireEvent.click(link); // opening the record remembers the row
    document.removeEventListener('click', stay);
    unmount();
    render(
      <>
        <RecordTable
          def={jobsObject}
          state={parseView(jobsObject, {})}
          rows={rows}
          tableId="ft"
          caption="Jobs"
        />
        <TableKeys tableId="ft" searchId="none" />
      </>,
    );
    expect(document.activeElement?.getAttribute('href')).toBe('/jobs/job_2');
  });

  it('a modified (new-tab) click on a row link does not become the row to restore', () => {
    const tree = () => (
      <>
        <RecordTable
          def={jobsObject}
          state={parseView(jobsObject, {})}
          rows={rows}
          tableId="mt"
          caption="Jobs"
        />
        <TableKeys tableId="mt" searchId="none" />
      </>
    );
    sessionStorage.clear();
    const { unmount } = render(tree());
    const link = within(screen.getAllByRole('row')[2]!)
      .getByRole('rowheader')
      .querySelector<HTMLElement>('[data-row-link]')!;
    const stay = (e: Event) => e.preventDefault();
    document.addEventListener('click', stay);
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { shiftKey: true });
    document.removeEventListener('click', stay);
    unmount();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    render(tree());
    expect(document.activeElement?.getAttribute('href') ?? null).toBeNull();
  });

  it('the sort menu marks the current sort', () => {
    render(
      <ViewBar def={jobsObject} state={parseView(jobsObject, { sort: 'title' })} rows={[]} searchId="s" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    expect(screen.getByRole('menuitem', { name: 'Title ↑ ascending' }).getAttribute('aria-current')).toBe(
      'true',
    );
    expect(
      screen.getByRole('menuitem', { name: 'Title ↓ descending' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('pager: page sizes, and no row numbers past the kept cursor trail', () => {
    render(
      <Pager
        def={jobsObject}
        state={parseView(jobsObject, { after: 'c30', prev: ['c10', 'c11'] })}
        shown={50}
        total={null}
        nextCursor="c31"
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Pagination' });
    expect(nav.textContent).toContain('50 rows · page 3+');
    const sizes = within(nav).getByRole('group', { name: 'Rows per page' });
    expect(within(sizes).getByText('50').getAttribute('aria-current')).toBe('true');
    expect(within(sizes).getByRole('link', { name: '25' }).getAttribute('href')).toBe('/jobs?limit=25');
  });

  it('compact salary, sentence-case enums and no "Basis: none" in summaries', () => {
    render(
      <RecordTable
        def={jobsObject}
        state={parseView(jobsObject, {})}
        rows={rows}
        tableId="t"
        caption="Jobs"
      />,
    );
    const first = screen.getAllByRole('row')[1]!;
    expect(first.textContent).toContain('£60k–£80k / year');
    expect(first.textContent).toContain('Remote');
    cleanup();
    const withNone = job('job_n', {
      geography: { ...job('x').geography, workModel: sf('remote', { basis: 'none' }) },
    });
    const { container } = render(
      <RecordTable
        def={jobsObject}
        state={parseView(jobsObject, {})}
        rows={[withNone]}
        tableId="t"
        caption="Jobs"
      />,
    );
    expect(container.textContent).not.toMatch(/Basis: none/);
  });
});

describe('registries', () => {
  it('every filter and sort is a contract parameter; system views use only declared filters', () => {
    for (const def of [jobsObject, companiesObject, sourcesObject, reviewObject, runsObject]) {
      const params = new Set(def.filters.map((f) => f.param));
      for (const v of def.views)
        for (const k of Object.keys(v.filters ?? {})) expect(params.has(k)).toBe(true);
      for (const c of def.columns) if (c.sort) expect(def.sorts.some((s) => s.key === c.sort)).toBe(true);
      expect(def.columns.filter((c) => c.identity)).toHaveLength(1);
      // Every system view's preset is itself a valid URL state.
      for (const v of def.views) {
        const state = parseView(def, {
          view: v.id,
          ...Object.fromEntries(Object.entries(v.filters ?? {}).map(([k, x]) => [k, x.join(',')])),
        });
        expect(state.ignored).toEqual([]);
      }
    }
  });
});

const reviewItem = (id: string, over: Partial<ReviewListItem> = {}): ReviewListItem => ({
  _id: id,
  type: 'field_conflict',
  severity: 'high',
  priority: 310,
  status: 'open',
  dedupeKey: 'k',
  entity: { kind: 'job', id: 'job_9' },
  subject: `Senior Engineer: sources disagree (${id})`,
  reason: 'Lower-authority copies disagree',
  evidence: [],
  candidates: [{ kind: 'company', id: 'cmp_2', label: 'Acme Ltd' }],
  observationIds: [],
  context: {},
  allowedActions: ['confirm', 'dismiss'],
  occurrences: 2,
  createdAt: '2026-09-28T10:00:00Z',
  updatedAt: '2026-09-29T10:00:00Z',
  queueState: 'open',
  ...over,
});

describe('Review list', () => {
  it('renders queue states exactly as returned, with severity tone and named links', () => {
    const rows = [
      reviewItem('rev_1', {
        queueState: 'resolving',
        claim: { operationId: 'op', actor: { kind: 'operator', id: 'ana' }, action: 'merge', reason: 'dup' },
      }),
      reviewItem('rev_2', {
        queueState: 'failed',
        lastFailure: {
          operationId: 'op2',
          action: 'merge',
          kind: 'domain_conflict',
          code: 'target_merged',
          message: 'target was merged away',
          at: '2026-09-29T09:00:00Z',
        },
      }),
    ];
    render(
      <RecordTable
        def={reviewObject}
        state={parseView(reviewObject, {})}
        rows={rows}
        tableId="t"
        caption="Review"
      />,
    );
    const [, first, second] = screen.getAllByRole('row');
    expect(first!.textContent).toContain('Resolving');
    expect(first!.textContent).toContain('Merge by ana');
    expect(within(second!).getByText('previous merge failed').getAttribute('title')).toBe(
      'target was merged away',
    );
    // The item names only the entity's kind and id: Entity is not a default column.
    expect(screen.queryByRole('columnheader', { name: 'Entity' })).toBeNull();
    expect(first!.textContent).toContain('Acme Ltd');
    expect(within(first!).getByRole('rowheader').querySelector('a')!.getAttribute('href')).toBe(
      '/review/rev_1',
    );
    // Default sort for open items is priority; Created is sortable.
    expect(
      within(screen.getByRole('columnheader', { name: 'Created' }))
        .getByRole('link')
        .getAttribute('href'),
    ).toBe('/review?sort=createdAt');
  });

  it('leads with severity; an open item state is quiet text, and priority sorts highest first', () => {
    render(
      <RecordTable
        def={reviewObject}
        state={parseView(reviewObject, {})}
        rows={[reviewItem('rev_1')]}
        tableId="t"
        caption="Review"
      />,
    );
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent!.replace(/[↑↓]/g, '').trim());
    expect(heads.indexOf('Severity')).toBeLessThan(heads.indexOf('State'));
    const state = within(screen.getAllByRole('row')[1]!).getByText('Open');
    expect(state.className).toContain('muted');
    cleanup();
    render(<ViewBar def={reviewObject} state={parseView(reviewObject, {})} rows={[]} searchId="s" />);
    expect(screen.getByRole('button', { name: /^Sort/ }).textContent).toContain('Priority: highest first');
  });

  it('decided items: quiet severity, no actor in the State cell (the preview has it)', () => {
    const r = reviewItem('rev_3', {
      queueState: 'resolved',
      status: 'resolved',
      resolution: {
        action: 'merge',
        reason: 'dup',
        actor: { kind: 'operator', id: 'ana' },
        at: '2026-09-29T10:00:00Z',
      },
    } as Partial<ReviewListItem>);
    render(
      <RecordTable
        def={reviewObject}
        state={parseView(reviewObject, { status: 'resolved' })}
        rows={[r]}
        tableId="t"
        caption="Review"
      />,
    );
    const row = screen.getAllByRole('row')[1]!;
    expect(row.textContent).toContain('Resolved');
    expect(row.textContent).not.toContain('ana');
    expect(row.querySelector('th')!.className).toMatch(/identityWrap/);
    cleanup();
    const items = reviewObject.peek(r);
    expect(items.map((i) => i.label).slice(0, 3)).toEqual(['Severity', 'State', 'Type']);
    render(
      <>
        {items.map((i) => (
          <div key={i.label}>{i.value}</div>
        ))}
      </>,
    );
    expect(document.body.textContent).toContain('Merge by ana');
  });

  it('status=open is the API default: the canonical URL is /review', () => {
    const raw = { status: 'open' };
    const s = parseView(reviewObject, raw);
    expect(s.ignored).toEqual([]);
    expect(canonicalHref(reviewObject, raw, s)).toBe('/review');
  });

  it('sort labels read the same way for every key', () => {
    render(<ViewBar def={reviewObject} state={parseView(reviewObject, {})} rows={[]} searchId="s" />);
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Priority: highest first',
      'Priority: lowest first',
      'Created: oldest first',
      'Created: newest first',
      'Updated: oldest first',
      'Updated: newest first',
    ]);
  });

  it('gives each decided view its own empty state', () => {
    expect(reviewObject.views.find((v) => v.id === 'resolved')!.empty).toBe('No resolved items yet.');
  });

  it('decided views use the API order (last update) and offer no triage claim filter yet', () => {
    const s = parseView(reviewObject, { status: 'resolved' });
    expect(s.view).toBe('resolved');
    expect(s.sort).toBe('-updatedAt');
    expect(reviewObject.filters.some((f) => f.param === 'claimed')).toBe(false); // Market PR #22
    render(<ViewBar def={reviewObject} state={s} rows={[]} searchId="review-search" />);
    expect(screen.queryByRole('search')).toBeNull(); // the review API has no q
    expect(screen.getByRole('link', { name: 'Resolved' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const status = within(screen.getByRole('dialog', { name: 'Filter review items' })).getByRole('group', {
      name: 'Status',
    });
    expect(
      within(status)
        .getAllByRole('radio')
        .map((r) => r.parentElement!.textContent!.trim()),
    ).toEqual(['Open', 'Resolved', 'Dismissed', 'All statuses']);
  });
});

const run = (id: string, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  _id: id,
  workflowKey: 'market.ats.refresh',
  workflowVersion: 3,
  versionId: 'v',
  state: 'COMPLETED',
  trigger: { kind: 'schedule' } as WorkflowRun['trigger'],
  rootRunId: id,
  depth: 0,
  labels: { sourceId: 'src_1' },
  capabilityVersions: {},
  failedNodeIds: [],
  durationMs: 1500,
  createdAt: '2026-09-29T10:00:00Z',
  updatedAt: '2026-09-29T10:00:02Z',
  ...over,
});

describe('Runs list', () => {
  it('has no sortable headers or sort menu (fixed newest-first order) and names the source', () => {
    const state = parseView(runsObject, {});
    render(
      <RecordTable
        def={runsObject}
        state={state}
        rows={[
          run('run_1'),
          run('run_2', {
            labels: { sourceId: 'src_x' },
            trigger: { kind: 'manual', actor: { kind: 'operator', id: 'ana' } } as WorkflowRun['trigger'],
          }),
        ]}
        tableId="t"
        caption="Runs"
      />,
    );
    expect(screen.getAllByRole('columnheader').every((h) => !h.querySelector('a'))).toBe(true);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Run',
      'State',
      'Source',
      'Created',
      'Duration',
      'Trigger',
    ]);
    const [, first, second] = screen.getAllByRole('row');
    // The source name (from the sources list) tells rows apart, in the name and its own column.
    const name = within(first!).getByRole('rowheader');
    expect(name.textContent).toBe('ats.refresh');
    expect(name.querySelector('[data-row-link]')!.getAttribute('title')).toBe('ats.refresh · Acme careers');
    expect(within(first!).getByRole('link', { name: 'Acme careers' }).getAttribute('href')).toBe(
      '/sources/src_1',
    );
    // Unknown source: the id, linked. The trigger shows the kind; the actor is in the preview only.
    expect(within(second!).getByRole('link', { name: 'src_x' }).getAttribute('href')).toBe('/sources/src_x');
    expect(second!.textContent).toContain('Manual');
    expect(second!.textContent).not.toContain('ana');
    expect(first!.textContent).not.toMatch(/top-level/i);
    cleanup();
    render(
      <ViewBar
        def={runsObject}
        state={state}
        rows={[]}
        searchId="runs-search"
        suggestions={{ workflowKey: ['a.b'] }}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Sort/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const input = screen.getByRole('combobox', { name: 'Workflow' }) as HTMLInputElement;
    expect(
      document.getElementById(input.getAttribute('list')!)?.querySelector('option')?.getAttribute('value'),
    ).toBe('a.b');
  });

  it('names the source from the sources list only (a run label never outranks it)', () => {
    const rows = [
      run('run_1', { labels: { sourceId: 'src_1', sourceName: 'Spoofed' } }),
      run('run_2', { labels: { sourceId: 'constructor' } }),
    ];
    render(
      <RecordTable
        def={runsObject}
        state={parseView(runsObject, {})}
        rows={rows}
        tableId="t"
        caption="Runs"
      />,
    );
    const [, first, second] = screen.getAllByRole('row');
    expect(first!.textContent).toContain('Acme careers');
    expect(first!.textContent).not.toContain('Spoofed');
    expect(within(second!).getByRole('link', { name: 'constructor' }).getAttribute('href')).toBe(
      '/sources/constructor',
    );
  });

  it('shows lineage in the child-runs view only, and the preview has no empty Error', () => {
    expect(visibleColumns(runsObject, parseView(runsObject, { all: 'true' }))).toContain('lineage');
    expect(visibleColumns(runsObject, parseView(runsObject, {}))).not.toContain('lineage');
    const r = run('run_1', {
      trigger: { kind: 'manual', actor: { kind: 'operator', id: 'ana' } } as WorkflowRun['trigger'],
    });
    const items = runsObject.peek!(r);
    expect(items.map((i) => i.label)).not.toContain('Error');
    render(
      <>
        {items.map((i) => (
          <div key={i.label}>{i.value}</div>
        ))}
      </>,
    );
    expect(document.body.textContent).toContain('Manual (ana)');
    cleanup();
    expect(
      runsObject.peek!(
        run('run_2', { state: 'FAILED', error: { message: 'board token missing' } } as Partial<WorkflowRun>),
      ).map((i) => i.label),
    ).toContain('Error');
  });

  it('pages by offset; a page-size link starts again from the first row', () => {
    render(
      <Pager
        def={runsObject}
        state={parseView(runsObject, { offset: '50', limit: '10' })}
        shown={10}
        total={130}
        nextCursor={null}
      />,
    );
    const size = screen.getByRole('link', { name: '25' }).getAttribute('href')!;
    expect(size).toBe('/runs?limit=25');
    expect(new URLSearchParams(size.split('?')[1]).has('offset')).toBe(false);
  });

  it('pages by offset with the total', () => {
    render(
      <Pager
        def={runsObject}
        state={parseView(runsObject, { offset: '50' })}
        shown={50}
        total={130}
        nextCursor={null}
      />,
    );
    expect(screen.getByRole('navigation', { name: 'Pagination' }).textContent).toContain('51–100 of 130');
    expect(screen.getByRole('link', { name: 'Next →' }).getAttribute('href')).toBe('/runs?offset=100');
    expect(screen.getByRole('link', { name: '← Previous' }).getAttribute('href')).toBe('/runs');
  });
});

describe('ViewTabs', () => {
  it('scrolls the current tab into the strip (horizontally) when it is off to the right', () => {
    const proto = HTMLElement.prototype;
    const saved = ['scrollWidth', 'clientWidth', 'offsetLeft', 'offsetWidth'].map(
      (k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
    );
    const size = (el: HTMLElement, k: string) =>
      el.tagName === 'NAV'
        ? { scrollWidth: 800, clientWidth: 360, offsetLeft: 0, offsetWidth: 360 }[k]
        : {
            scrollWidth: 90,
            clientWidth: 90,
            offsetLeft: 100 * [...el.parentElement!.children].indexOf(el),
            offsetWidth: 90,
          }[k];
    for (const [k] of saved)
      Object.defineProperty(proto, k, {
        configurable: true,
        get(this: HTMLElement) {
          return size(this, k);
        },
      });
    try {
      render(
        <ViewBar
          def={jobsObject}
          state={parseView(jobsObject, { state: 'POSSIBLY_STALE' })}
          rows={[]}
          searchId="s"
        />,
      );
      const nav = screen.getByRole('navigation', { name: 'Jobs views' });
      const current = within(nav).getByRole('link', { name: 'Possibly stale' });
      expect(current.getAttribute('aria-current')).toBe('page');
      const left = size(current, 'offsetLeft')!;
      expect(nav.scrollLeft).toBeGreaterThan(0);
      expect(left + 90).toBeLessThanOrEqual(nav.scrollLeft + 360);
    } finally {
      for (const [k, d] of saved) if (d) Object.defineProperty(proto, k, d);
    }
  });
});
