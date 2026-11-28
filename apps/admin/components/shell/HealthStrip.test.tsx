// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISMISS_KEY, HealthNoticeReset, HealthStrip, readDismissed, writeDismissed } from './HealthStrip';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const strip = (signature: string) => (
  <HealthStrip
    signature={signature}
    headline="Data is temporarily unavailable."
    detail="Retrying automatically."
  />
);

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('HealthStrip dismissal', () => {
  it('hides on Dismiss and remembers the failure signature for this session', () => {
    render(strip('not_ready:mongo'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(sessionStorage.getItem(DISMISS_KEY)).toBe('not_ready:mongo');
  });

  it('stays hidden for the same failure and shows again for a new kind of failure', () => {
    sessionStorage.setItem(DISMISS_KEY, 'not_ready:mongo');
    const { rerender } = render(strip('not_ready:mongo'));
    expect(screen.queryByRole('status')).toBeNull();
    rerender(strip('not_ready:mongo,redis'));
    expect(screen.getByRole('status').dataset.signature).toBe('not_ready:mongo,redis');
  });

  it('forgets the dismissal once the API is ready again', () => {
    sessionStorage.setItem(DISMISS_KEY, 'unavailable:');
    render(<HealthNoticeReset />);
    expect(sessionStorage.getItem(DISMISS_KEY)).toBeNull();
  });

  it('keeps working when sessionStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readDismissed()).toBeNull();
    expect(() => writeDismissed('x')).not.toThrow();
    render(strip('unavailable:'));
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the local setup hint collapsed when given', () => {
    render(
      <HealthStrip
        signature="not_ready:mongo"
        headline="Data is temporarily unavailable."
        detail="x"
        devHints={['MongoDB isn’t reachable. Check MONGODB_URI in .env.']}
      />,
    );
    const details = screen.getByText('Local setup hint').closest('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('MONGODB_URI');
  });
});
