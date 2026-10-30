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
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const health = (state: ApiHealth['state']): ApiHealth => ({ state, url: 'http://api.test', checks: null });

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
  it('stays silent while the API is ready', async () => {
    mocks.getApiHealth.mockResolvedValue(health('ready'));
    expect(await HealthNotice()).toBeNull();
    render(await HealthDot());
    expect(screen.getByText('API ready').className).toBe('sr-only');
  });

  it('shows one shell callout and a short "Down" status when the API is unavailable', async () => {
    mocks.getApiHealth.mockResolvedValue(health('unavailable'));
    render(
      <>
        {await HealthNotice()}
        {await HealthDot()}
      </>,
    );
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('API unavailable');
    expect(notice.textContent).toContain('http://api.test');
    expect(screen.getByRole('link', { name: 'System status' }).getAttribute('href')).toBe('/settings/system');
    expect(screen.getByText('Down')).toBeTruthy();
  });
});
