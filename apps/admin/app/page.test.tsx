// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiFailure, ApiResult } from '@/lib/api';
import type { Dashboard, ReviewListItem, WorkflowRun } from '@/lib/types';
import DashboardPage from './page';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ apiGet: mocks.apiGet, API_BASE_URL: 'http://127.0.0.1:3000' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const HOUR = 3_600_000;

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, status: 200, data };
}

function failure(code: string, path: string): ApiResult<never> {
  const error: ApiFailure = {
    kind: 'http',
    status: 503,
    code,
    message: 'The service failed.',
    method: 'GET',
    path,
  };
  return { ok: false, error };
}

function dashboard(
  over: {
    open?: number;
    oldestOpenAgeMs?: number | null;
    failed?: number;
    active?: number;
    failing?: number;
    overdue?: number;
    due?: number;
    companies?: number;
    jobs?: number;
    lagging?: boolean;
  } = {},
): Dashboard {
  const failing = over.failing ?? 0;
  const overdue = over.overdue ?? 0;
  const failed = over.failed ?? 0;
  return {
    window: { since: iso(24 * HOUR), ms: 24 * HOUR },
    sources: { byHealth: { ok: 4, failing }, failing: [] },
    companies: { total: 10, created: over.companies ?? 0, changed: 0 },
    jobs: { byState: {}, created: over.jobs ?? 0, changed: 0, closed: 0 },
    review: { openByType: {}, open: over.open ?? 0, oldestOpenAgeMs: over.oldestOpenAgeMs ?? null },
    runs: {
      since: iso(24 * HOUR),
      runsByState: failed ? { FAILED: failed } : {},
      activeRuns: over.active ?? 0,
      nodeFailuresByCapability: {},
      waitingNodes: 0,
      retryScheduledNodes: 0,
      oldestQueuedAgeMs: null,
      meanAttemptsPerNode: null,
    },
    queues: over.lagging
      ? [
          {
            queue: 'market',
            waiting: 2,
            active: 0,
            delayed: 0,
            failed: 0,
            completed: 0,
            paused: 0,
            oldestWaitingAgeMs: 6 * 60_000,
          },
        ]
      : [],
    freshness: {
      overdueSources: Array.from({ length: overdue }, (_, i) => ({
        sourceId: `src_${i}`,
        key: `src_${i}`,
        name: `Source ${i}`,
        ageMs: 9_000_000,
        maxAgeMs: HOUR,
        status: 'overdue',
      })),
      jobsDueForVerification: over.due ?? 0,
    },
  };
}

function review(
  partial: Pick<ReviewListItem, '_id' | 'subject' | 'type' | 'createdAt'> & Partial<ReviewListItem>,
): ReviewListItem {
  return {
    severity: 'medium',
    priority: 1,
    status: 'open',
    dedupeKey: partial._id,
    entity: { kind: 'company', id: 'co_1' },
    reason: 'needs a decision',
    evidence: [],
    candidates: [],
    observationIds: [],
    context: {},
    allowedActions: ['confirm'],
    occurrences: 1,
    updatedAt: partial.createdAt,
    queueState: 'open',
    ...partial,
  };
}

function run(
  partial: Pick<WorkflowRun, '_id' | 'workflowKey' | 'createdAt'> & Partial<WorkflowRun>,
): WorkflowRun {
  return {
    workflowVersion: 1,
    versionId: 'ver_1',
    state: 'FAILED',
    trigger: { kind: 'manual' },
    rootRunId: partial._id,
    depth: 0,
    labels: {},
    capabilityVersions: {},
    failedNodeIds: [],
    updatedAt: partial.createdAt,
    ...partial,
  };
}

function mockApi({
  dash = ok(dashboard()),
  reviews = ok({ items: [] as ReviewListItem[], total: 0 }),
  runs = ok({ items: [] as WorkflowRun[], total: 0 }),
}: {
  dash?: ApiResult<Dashboard>;
  reviews?: ApiResult<{ items: ReviewListItem[]; total: number }>;
  runs?: ApiResult<{ items: WorkflowRun[]; total: number }>;
} = {}) {
  mocks.apiGet.mockImplementation(async (path: string) => {
    if (path === '/api/dashboard') return dash;
    if (path === '/api/review') return reviews;
    if (path === '/api/runs') return runs;
    throw new Error(`unexpected ${path}`);
  });
}

async function renderPage(search: Record<string, string | string[] | undefined> = {}) {
  render(await DashboardPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  mocks.apiGet.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('overview named attention', () => {
  it('requests the dashboard, open reviews and failed runs together', async () => {
    let release: (value: ApiResult<Dashboard>) => void = () => {};
    const gate = new Promise<ApiResult<Dashboard>>((resolve) => {
      release = resolve;
    });
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === '/api/dashboard') return gate;
      if (path === '/api/review') return Promise.resolve(ok({ items: [], total: 0 }));
      if (path === '/api/runs') return Promise.resolve(ok({ items: [], total: 0 }));
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    const pending = DashboardPage({ searchParams: Promise.resolve({}) });
    try {
      await waitFor(() => {
        expect(mocks.apiGet).toHaveBeenCalledWith('/api/dashboard', { hours: 24 });
        expect(mocks.apiGet).toHaveBeenCalledWith('/api/review', { status: 'open', limit: 5 });
        expect(mocks.apiGet).toHaveBeenCalledWith('/api/runs', { state: 'FAILED', limit: 5 });
      });
    } finally {
      release(ok(dashboard()));
      await pending;
    }
  });

  it('renders named reviews and failed runs with hrefs and ages', async () => {
    mockApi({
      dash: ok(dashboard({ open: 2, failed: 2, oldestOpenAgeMs: 3 * HOUR })),
      reviews: ok({
        items: [
          review({
            _id: 'rev/1',
            subject: 'Acme Ltd duplicate',
            type: 'company_resolution',
            createdAt: iso(3 * HOUR),
          }),
          review({
            _id: 'rev_2',
            subject: 'Senior engineer posted twice',
            type: 'job_duplicate',
            createdAt: iso(10 * 60_000),
          }),
        ],
        total: 2,
      }),
      runs: ok({
        items: [
          run({
            _id: 'run/9',
            workflowKey: 'market.ingest',
            createdAt: iso(HOUR),
            finishedAt: iso(5 * 60_000),
            error: { name: 'Error', message: 'board timed out' },
          }),
          run({
            _id: 'run_quiet',
            workflowKey: 'market.refresh',
            createdAt: iso(10 * 60_000),
          }),
        ],
        total: 2,
      }),
    });
    await renderPage();

    const acme = screen.getByRole('link', { name: 'Acme Ltd duplicate' });
    expect(acme.getAttribute('href')).toBe('/review/rev%2F1');
    expect(acme.closest('li')?.textContent).toContain('Company resolution');
    expect(acme.closest('li')?.textContent).toContain('3h ago');

    const job = screen.getByRole('link', { name: 'Senior engineer posted twice' });
    expect(job.getAttribute('href')).toBe('/review/rev_2');
    expect(job.closest('li')?.textContent).toContain('Job duplicate · 10m ago');

    const ingest = screen.getByRole('link', { name: 'market.ingest' });
    expect(ingest.getAttribute('href')).toBe('/runs/run%2F9');
    expect(ingest.getAttribute('title')).toBe('board timed out');
    expect(ingest.closest('li')?.textContent).toContain('5m ago');

    const refresh = screen.getByRole('link', { name: 'market.refresh' });
    expect(refresh.getAttribute('href')).toBe('/runs/run_quiet');
    expect(refresh.hasAttribute('title')).toBe(false);
    expect(refresh.closest('li')?.textContent).toContain('10m ago');

    expect(screen.getByRole('heading', { level: 3, name: 'Open reviews' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Failed runs (24h)' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Open reviews' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Failed runs (24h)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View all open reviews' }).getAttribute('href')).toBe('/review');
    expect(screen.getByRole('link', { name: 'View all failed runs' }).getAttribute('href')).toBe(
      '/runs?state=FAILED',
    );
  });

  it('drops failed runs created outside the selected window', async () => {
    const runs = ok({
      items: [
        run({
          _id: 'run_recent',
          workflowKey: 'market.recent',
          createdAt: iso(2 * HOUR),
          finishedAt: iso(5 * 60_000),
          error: { name: 'Error', message: 'connector timed out' },
        }),
        run({
          _id: 'run_edge',
          workflowKey: 'market.edge',
          createdAt: iso(24 * HOUR),
        }),
        run({
          _id: 'run_old',
          workflowKey: 'market.old',
          createdAt: iso(24 * HOUR + 1),
          finishedAt: iso(60_000),
        }),
      ],
      total: 3,
    });
    mockApi({ runs });
    await renderPage();

    expect(screen.getByRole('heading', { level: 3, name: 'Failed runs (24h)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'market.recent' }).closest('li')?.textContent).toContain(
      '5m ago',
    );
    expect(screen.getByRole('link', { name: 'market.edge' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'market.old' })).toBeNull();
    expect(screen.queryByText('No failed runs')).toBeNull();

    cleanup();
    mockApi({ runs });
    await renderPage({ hours: '72' });
    expect(mocks.apiGet).toHaveBeenCalledWith('/api/dashboard', { hours: 72 });
    expect(mocks.apiGet).toHaveBeenCalledWith('/api/runs', { state: 'FAILED', limit: 5 });
    expect(screen.getByRole('heading', { level: 3, name: 'Failed runs (72h)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'market.old' })).toBeTruthy();

    cleanup();
    mockApi({ runs });
    await renderPage({ hours: '168' });
    expect(screen.getByRole('heading', { level: 3, name: 'Failed runs (7d)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'market.old' })).toBeTruthy();
  });

  it('shows empty named lists without changing the quiet count row', async () => {
    mockApi();
    await renderPage();
    expect(screen.getByText('Nothing needs attention right now.')).toBeTruthy();
    expect(screen.getByText('No open reviews')).toBeTruthy();
    expect(screen.getByText('No failed runs')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View all open reviews' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View all failed runs' })).toBeTruthy();
  });

  it('keeps the count-row empty state and the verification cap', async () => {
    mockApi({
      reviews: ok({
        items: [
          review({
            _id: 'rev_stray',
            subject: 'Stray open review',
            type: 'source_anomaly',
            createdAt: iso(HOUR),
          }),
        ],
        total: 1,
      }),
    });
    await renderPage();
    expect(screen.getByText('Nothing needs attention right now.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Stray open review' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^\d[\d,]* open reviews?$/ })).toBeNull();

    cleanup();
    mockApi({ dash: ok(dashboard({ due: 1000, open: 1 })) });
    await renderPage();
    expect(screen.queryByText('Nothing needs attention right now.')).toBeNull();
    expect(screen.getByRole('link', { name: '1000+ jobs due verification' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '1 open review' })).toBeTruthy();
    expect(screen.getByText('No open reviews')).toBeTruthy();
    expect(screen.getByText('No failed runs')).toBeTruthy();
  });

  it('shows a reviews error without hiding runs or the cards', async () => {
    mockApi({
      dash: ok(dashboard({ open: 4, failed: 1, companies: 8 })),
      reviews: failure('review_unavailable', '/api/review?status=open&limit=5'),
      runs: ok({
        items: [
          run({
            _id: 'run_ok',
            workflowKey: 'market.ingest',
            createdAt: iso(HOUR),
            finishedAt: iso(HOUR),
          }),
        ],
        total: 1,
      }),
    });
    await renderPage();

    const reviews = screen.getByRole('list', { name: 'Open reviews' });
    expect(reviews.textContent).toContain("Couldn't load open reviews");
    expect(reviews.textContent).toContain('review_unavailable');
    expect(screen.queryByText('No open reviews')).toBeNull();
    expect(screen.getByRole('link', { name: 'market.ingest' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Key indicators' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '4 open reviews' })).toBeTruthy();
    expect(screen.getByText('+8')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'API error' })).toBeNull();
  });

  it('shows a runs error without hiding reviews or the cards', async () => {
    mockApi({
      dash: ok(dashboard({ open: 1, failed: 2 })),
      reviews: ok({
        items: [
          review({
            _id: 'rev_ok',
            subject: 'Acme Ltd duplicate',
            type: 'company_resolution',
            createdAt: iso(HOUR),
          }),
        ],
        total: 1,
      }),
      runs: failure('runs_unavailable', '/api/runs?state=FAILED&limit=5'),
    });
    await renderPage();

    const failed = screen.getByRole('list', { name: 'Failed runs (24h)' });
    expect(failed.textContent).toContain("Couldn't load failed runs");
    expect(failed.textContent).toContain('runs_unavailable');
    expect(screen.queryByText('No failed runs')).toBeNull();
    expect(screen.getByRole('link', { name: 'Acme Ltd duplicate' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Key indicators' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '2 failed runs (24h)' })).toBeTruthy();
  });

  it('still renders both named lists when the dashboard fails', async () => {
    mockApi({
      dash: failure('dash_down', '/api/dashboard?hours=24'),
      reviews: ok({
        items: [
          review({
            _id: 'rev_ok',
            subject: 'Acme Ltd duplicate',
            type: 'company_resolution',
            createdAt: iso(3 * HOUR),
          }),
        ],
        total: 1,
      }),
      runs: ok({
        items: [
          run({
            _id: 'run_ok',
            workflowKey: 'market.ingest',
            createdAt: iso(HOUR),
            finishedAt: iso(5 * 60_000),
            error: { name: 'Error', message: 'board timed out' },
          }),
          run({ _id: 'run_old', workflowKey: 'market.old', createdAt: iso(48 * HOUR) }),
        ],
        total: 2,
      }),
    });
    await renderPage();

    expect(screen.getByRole('heading', { name: 'API error' })).toBeTruthy();
    expect(screen.getByText('dash_down')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Key indicators' })).toBeNull();
    expect(screen.queryByText('Nothing needs attention right now.')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'What needs attention' })).toBeNull();

    expect(screen.getByRole('link', { name: 'Acme Ltd duplicate' }).getAttribute('href')).toBe(
      '/review/rev_ok',
    );
    expect(screen.getByRole('link', { name: 'Acme Ltd duplicate' }).closest('li')?.textContent).toContain(
      '3h ago',
    );
    expect(screen.getByRole('link', { name: 'market.ingest' }).getAttribute('title')).toBe('board timed out');
    expect(screen.queryByRole('link', { name: 'market.old' })).toBeNull();
    expect(screen.getByRole('link', { name: 'View all open reviews' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View all failed runs' })).toBeTruthy();
  });
});
