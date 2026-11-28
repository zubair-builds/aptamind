// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HealthModule from '@/lib/health';
import type { ApiHealth } from '@/lib/health';
import { HealthDot, HealthNotice, ReviewCount } from './status';

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn(), getApiHealth: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiRequest: mocks.apiRequest, API_BASE_URL: 'http://api.test' }));
vi.mock('@/lib/health', async (importOriginal) => ({
  ...(await importOriginal<typeof HealthModule>()),
  getApiHealth: mocks.getApiHealth,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const health = (state: ApiHealth['state'], checks: ApiHealth['checks'] = null): ApiHealth => ({
  state,
  url: 'http://api.test',
  checks,
});

beforeEach(() => {
  mocks.apiRequest.mockReset();
  mocks.getApiHealth.mockReset();
});
afterEach(cleanup);

describe('ReviewCount', () => {
  it('shows the open review count, asking for one row with a short timeout', async () => {
    mocks.apiRequest.mockResolvedValue({ ok: true, status: 200, data: { total: 12 } });
    render(await ReviewCount());
    expect(screen.getByText(/12/).textContent).toBe('12 open');
    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/review', {
      query: { status: 'open', limit: 1 },
      timeoutMs: 3000,
    });
  });

  it('renders nothing for an empty queue or an API error', async () => {
    mocks.apiRequest.mockResolvedValueOnce({ ok: true, status: 200, data: { total: 0 } });
    expect(await ReviewCount()).toBeNull();
    mocks.apiRequest.mockResolvedValueOnce({ ok: false, error: { kind: 'unavailable' } });
    expect(await ReviewCount()).toBeNull();
  });
});

describe('API health', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    sessionStorage.clear();
  });

  it('stays silent while the API is ready and forgets an earlier dismissal', async () => {
    sessionStorage.setItem('aptamind.healthNotice.dismissed', 'unavailable:');
    mocks.getApiHealth.mockResolvedValue(health('ready'));
    render(await HealthNotice());
    expect(screen.queryByRole('status')).toBeNull();
    expect(sessionStorage.getItem('aptamind.healthNotice.dismissed')).toBeNull();
    render(await HealthDot());
    expect(screen.getByText('API ready').className).toBe('sr-only');
  });

  it('shows one calm strip without the internal URL, and a short "Down" status, when unavailable', async () => {
    mocks.getApiHealth.mockResolvedValue(health('unavailable'));
    render(
      <>
        {await HealthNotice()}
        {await HealthDot()}
      </>,
    );
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('Data is temporarily unavailable.');
    expect(notice.textContent).not.toContain('http://');
    expect(notice.textContent).not.toContain('API not ready');
    expect(screen.getByRole('link', { name: 'Details' }).getAttribute('href')).toBe('/settings/system#api');
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    expect(screen.getByText('Down')).toBeTruthy();
  });

  it('tailors the copy to the dependency that is down', async () => {
    mocks.getApiHealth.mockResolvedValue(
      health('not_ready', { mongo: true, redis: false, objectStorage: true }),
    );
    render(await HealthNotice());
    expect(screen.getByRole('status').textContent).toContain('Background jobs are paused.');
  });

  it('adds a collapsed local-setup hint outside production only', async () => {
    mocks.getApiHealth.mockResolvedValue(
      health('not_ready', { mongo: false, redis: true, objectStorage: true }),
    );
    vi.stubEnv('NODE_ENV', 'development');
    render(await HealthNotice());
    expect(screen.getByText('Local setup hint')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('MONGODB_URI');
    cleanup();
    vi.stubEnv('NODE_ENV', 'production');
    render(await HealthNotice());
    expect(screen.queryByText('Local setup hint')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Data is temporarily unavailable.');
  });
});

describe('AuthChip', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('says password protected only when ADMIN_PASSWORD is set', async () => {
    const { AuthChip } = await import('./status');
    vi.stubEnv('ADMIN_PASSWORD', 'x');
    render(AuthChip());
    expect(screen.getByText('Internal · password protected')).toBeTruthy();
    cleanup();
    vi.stubEnv('ADMIN_PASSWORD', '');
    render(AuthChip());
    expect(screen.getByText('Internal · no auth')).toBeTruthy();
  });
});
