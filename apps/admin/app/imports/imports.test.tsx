// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MappedImportPage } from '@/components/imports/MappedImportPage';
import { RecordList } from '@/components/records/table/RecordList';
import { importsObject } from '@/components/records/registry/imports';
import type { ImportDetail } from '@/lib/types';
import ImportPage from './[id]/page';
import ImportJobLinksPage from './new/jobs/page';
import NewImportPage from './new/page';

const mocks = vi.hoisted(() => ({
  getImport: vi.fn(),
  apiGet: vi.fn(),
  refresh: vi.fn(),
  startImport: vi.fn(),
}));
vi.mock('@/lib/imports', () => ({ getImport: mocks.getImport }));
vi.mock('@/lib/api', () => ({ apiGet: mocks.apiGet }));
vi.mock('@/lib/import-actions', () => ({ startMappedImportAction: mocks.startImport }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/imports',
  useSearchParams: () => new URLSearchParams(),
  redirect: (href: string) => {
    throw new Error(`redirect ${href}`);
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const IMP: ImportDetail = {
  _id: 'imp_1',
  type: 'companies',
  fileName: 'uk-fintechs.csv',
  contentType: 'text/csv',
  bytes: 2048,
  contentHash: 'sha256:abc123',
  artifactId: 'art_1',
  snapshotId: 'snap_1',
  snapshotUnchanged: false,
  sourceId: 'src_1',
  runId: 'run_1',
  createdBy: { kind: 'operator', id: 'admin' },
  createdAt: '2026-09-30T10:00:00.000Z',
  source: { id: 'src_1', name: 'UK fintechs', provider: 'company_directory' },
  status: 'completed_with_issues',
  startedAt: '2026-09-30T10:00:01.000Z',
  finishedAt: '2026-09-30T10:00:09.000Z',
  counts: {
    rows: 12,
    parsed: 12,
    accepted: 11,
    created: 9,
    updated: 2,
    unchanged: 0,
    ignored: 0,
    failed: 1,
    reviews: 1,
  },
  trace: {
    runId: 'run_1',
    snapshotId: 'snap_1',
    artifactId: 'art_1',
    reviewIds: ['rev_1'],
    companyIds: ['co_1', 'co_2'],
    sourceIds: [],
    truncated: false,
  },
};

const hrefs = () => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));

beforeEach(() => {
  mocks.getImport.mockReset();
  mocks.apiGet.mockReset();
  mocks.startImport.mockReset();
});
afterEach(cleanup);

describe('/imports/[id]', () => {
  it('shows the counts, links and hash the API returns', async () => {
    mocks.getImport.mockResolvedValue({ ok: true, status: 200, data: IMP });
    render(await ImportPage({ params: Promise.resolve({ id: 'imp_1' }) }));
    expect(mocks.getImport).toHaveBeenCalledWith('imp_1');
    expect(screen.getByRole('heading', { name: 'uk-fintechs.csv' })).toBeTruthy();
    expect(screen.getByText('Reviews opened')).toBeTruthy();
    expect(screen.getByText('sha256:abc123')).toBeTruthy();
    expect(hrefs()).toEqual(
      expect.arrayContaining([
        '/sources/src_1',
        '/runs/run_1',
        '/snapshots/snap_1',
        '/review/rev_1',
        '/companies/co_1',
        '/companies/co_2',
      ]),
    );
    expect(screen.queryByText(/This page refreshes/)).toBeNull();
    expect(screen.getByText('Import finished: completed with issues.').getAttribute('role')).toBe('status');
    // An older API build: no warnings count and no report, and nothing breaks.
    expect(screen.queryByText('Warnings')).toBeNull();
    expect(screen.queryByText('Import report')).toBeNull();
  });

  it('shows the warnings count and the import report when the API sends them', async () => {
    mocks.getImport.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        ...IMP,
        counts: { ...IMP.counts, warnings: 4 },
        trace: { ...IMP.trace, reportArtifactId: 'art_report' },
      },
    });
    render(await ImportPage({ params: Promise.resolve({ id: 'imp_1' }) }));
    expect(screen.getByText('Warnings').nextElementSibling?.textContent).toBe('4');
    expect(
      screen
        .getByText(/Import report \(row warnings/)
        .closest('a')
        ?.getAttribute('href'),
    ).toBe('/artifacts/art_report');
  });

  it('explains every ATS board report code next to the report link', async () => {
    mocks.getImport.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...IMP, type: 'ats_boards', trace: { ...IMP.trace, reportArtifactId: 'art_report' } },
    });
    render(await ImportPage({ params: Promise.resolve({ id: 'imp_1' }) }));
    const legend = screen.getByText('What the row codes in the report mean').closest('details')!;
    const text = (code: string) =>
      [...legend.querySelectorAll('dt')].find((d) => d.textContent === code)?.nextElementSibling?.textContent;
    expect(text('not_an_ats_url')).toMatch(/^Warning\. The URL is not a Greenhouse, Ashby or Lever board/);
    expect(text('board_not_live')).toMatch(/^Failed\. The board does not exist/);
    expect(text('board_unreachable')).toMatch(/Import the file again to retry/);
    expect(text('no_identity')).toMatch(/no company name or domain/);
    expect(text('url_mismatch')).toMatch(/does not match the URL/);
    expect(text('missing_board')).toMatch(/no provider, token or URL/);
    expect(text('invalid_url')).toMatch(/no board token can be read/);
  });

  it('explains the same board report codes for a job link import', async () => {
    mocks.getImport.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...IMP, type: 'jobs', trace: { ...IMP.trace, reportArtifactId: 'art_report' } },
    });
    render(await ImportPage({ params: Promise.resolve({ id: 'imp_1' }) }));
    expect(screen.getAllByText('Job links').length).toBeGreaterThan(0);
    expect(screen.getByText('Boards registered')).toBeTruthy();
    expect(screen.getByText('What the row codes in the report mean')).toBeTruthy();
  });

  it('shows no ATS code legend for other import types or without a report', async () => {
    mocks.getImport.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...IMP, trace: { ...IMP.trace, reportArtifactId: 'art_report' } },
    });
    render(await ImportPage({ params: Promise.resolve({ id: 'imp_1' }) }));
    expect(screen.queryByText('What the row codes in the report mean')).toBeNull();
    cleanup();
    mocks.getImport.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...IMP, type: 'ats_boards', trace: { ...IMP.trace, reportArtifactId: null } },
    });
    render(await ImportPage({ params: Promise.resolve({ id: 'imp_1' }) }));
    expect(screen.queryByText('What the row codes in the report mean')).toBeNull();
  });

  it('labels ATS board counts and names the import source in the trace', async () => {
    mocks.getImport.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...IMP, type: 'ats_boards', trace: { ...IMP.trace, sourceIds: ['src_1', 'src_9'] } },
    });
    render(await ImportPage({ params: Promise.resolve({ id: 'imp_1' }) }));
    expect(screen.getByText('Boards registered')).toBeTruthy();
    expect(screen.getAllByText('Created')).toHaveLength(1); // the record's own Created date only
    expect(screen.getByText('Sources linked (2)')).toBeTruthy();
    const trace = screen.getByText('Sources linked (2)').nextElementSibling!;
    expect([...trace.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['UK fintechs', 'src_9']);
  });

  it('says it is processing and shows unknown counts as a dash', async () => {
    const counts = Object.fromEntries(
      Object.keys(IMP.counts).map((k) => [k, null]),
    ) as unknown as ImportDetail['counts'];
    mocks.getImport.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...IMP, status: 'processing', runId: 'run_1', finishedAt: null, counts },
    });
    render(await ImportPage({ params: Promise.resolve({ id: 'imp_1' }) }));
    expect(screen.getByText(/This page refreshes/).getAttribute('role')).toBe('status');
    expect(screen.getAllByTitle('Not known yet')).toHaveLength(9);
  });

  it('shows a not-found panel on 404', async () => {
    mocks.getImport.mockResolvedValue({
      ok: false,
      error: { status: 404, code: 'not_found', message: 'Import not found' },
    });
    render(await ImportPage({ params: Promise.resolve({ id: 'nope' }) }));
    expect(screen.getAllByText(/Import not found/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Trying again/)).toBeNull();
  });

  it('keeps polling and a live status line when loading fails for another reason', async () => {
    mocks.getImport.mockResolvedValue({
      ok: false,
      error: { status: 503, code: 'unavailable', message: 'API down' },
    });
    render(await ImportPage({ params: Promise.resolve({ id: 'imp_1' }) }));
    expect(screen.getByText(/could not be loaded\. Trying again/).getAttribute('role')).toBe('status');
  });
});

describe('/imports/new', () => {
  it('offers every import type, including job links', () => {
    render(<NewImportPage />);
    expect(hrefs()).toEqual([
      '/imports/new/companies',
      '/imports/new/ats-boards',
      '/imports/new/snapshot',
      '/imports/new/jobs',
    ]);
    expect(screen.getByRole('link', { name: /Job links/ })).toBeTruthy();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });
});

describe('/imports/new/jobs', () => {
  it('renders and requires a url mapping', async () => {
    mocks.apiGet.mockResolvedValue({ ok: true, status: 200, data: { items: [], nextCursor: null } });
    mocks.startImport.mockResolvedValue({ ok: true, importId: 'imp_9' });
    // The page is a server component that renders another. Next resolves that; the test does too.
    const page = ImportJobLinksPage();
    if (!isValidElement(page) || page.type !== MappedImportPage) throw new Error('expected MappedImportPage');
    const props = page.props as { type: string; subtitle: string };
    expect(props.type).toBe('jobs');
    if (props.type !== 'jobs') return;
    render(await MappedImportPage({ type: props.type, subtitle: props.subtitle }));
    expect(screen.getByRole('heading', { name: 'Import job links' })).toBeTruthy();
    expect(screen.getByText(/Each row is a job link \(Greenhouse, Ashby or Lever\)/)).toBeTruthy();
    expect(screen.getByText(/refreshed right away/)).toBeTruthy();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['Company,Notes\nAcme,x\n'], 'links.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    const company = (await screen.findByLabelText('Import Company as')) as HTMLSelectElement;
    expect(company.value).toBe('company');
    const values = [...company.options].map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(['url', 'company', 'domain']));
    expect(values).not.toContain('provider');
    expect(values).not.toContain('token');
    expect(screen.getByText('Choose a column for Job link.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start import' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Import Notes as'), { target: { value: 'url' } });
    expect(screen.queryByText('Choose a column for Job link.')).toBeNull();
    const start = screen.getByRole('button', { name: 'Start import' }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(mocks.startImport).toHaveBeenCalled());
    const fd = mocks.startImport.mock.calls[0]![0] as FormData;
    expect(fd.get('type')).toBe('jobs');
    expect(JSON.parse(fd.get('columns') as string)).toEqual({ company: 'Company', url: 'Notes' });
  });
});

describe('/imports list', () => {
  it('asks the API with the import filters and the cursor name', async () => {
    mocks.apiGet.mockResolvedValue({ ok: true, status: 200, data: { items: [IMP], nextCursor: 'c2' } });
    const tree = await RecordList({
      def: importsObject,
      params: { status: 'failed', after: 'c1', prev: '' },
    });
    expect(mocks.apiGet).toHaveBeenCalledWith(
      '/api/imports',
      expect.objectContaining({ status: 'failed', cursor: 'c1' }),
    );
    const q = mocks.apiGet.mock.calls[0]![1] as Record<string, unknown>;
    expect(q).not.toHaveProperty('count');
    expect(q).not.toHaveProperty('after');
    expect(tree).toBeTruthy();
  });
});
