// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiFailure } from '@/lib/api';
import { ApiErrorPanel } from './ApiError';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);

const failure = (over: Partial<ApiFailure>): ApiFailure => ({
  kind: 'http',
  status: 500,
  code: 'internal',
  message: 'boom',
  method: 'GET',
  path: '/api/jobs',
  ...over,
});

describe('ApiErrorPanel', () => {
  it('words an unreachable API calmly, without the internal base URL', () => {
    render(
      <ApiErrorPanel
        error={failure({ kind: 'unavailable', status: null, message: 'Internal API failed (TimeoutError).' })}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(screen.getByRole('heading', { name: "Couldn't load this right now" })).toBeTruthy();
    expect(alert.textContent).toContain('This is usually temporary');
    expect(alert.textContent).not.toContain('http://');
    expect(alert.textContent).not.toContain('API unavailable');
    expect(alert.textContent).toContain('GET /api/jobs — Internal API failed (TimeoutError).');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('keeps the code and HTTP status for an API error', () => {
    render(<ApiErrorPanel error={failure({ status: 503, code: 'not_ready', message: 'mongo down' })} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('not_ready');
    expect(alert.textContent).toContain('HTTP 503');
    expect(alert.textContent).toContain('mongo down');
  });
});
