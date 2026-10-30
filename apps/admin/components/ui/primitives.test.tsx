// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, ButtonLink, IconButton } from './Button';
import { CopyButton } from './CopyButton';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { Kbd } from './Kbd';
import { PropertyList } from './PropertyList';
import { Skeleton, SkeletonRows } from './Skeleton';
import { StatusPill } from './StatusPill';
import { Time } from './Time';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Button', () => {
  it('is a plain button by default and fires onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows "Working…" and blocks clicks while pending', () => {
    const onClick = vi.fn();
    render(
      <Button pending onClick={onClick}>
        Run now
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Working…' });
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('renders navigation as a link', () => {
    render(<ButtonLink href="/sources/new">New source</ButtonLink>);
    expect(screen.getByRole('link', { name: 'New source' }).getAttribute('href')).toBe('/sources/new');
  });

  it('gives icon-only buttons an accessible name', () => {
    render(<IconButton label="Copy link" icon="copy" />);
    const button = screen.getByRole('button', { name: 'Copy link' });
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('StatusPill and Kbd', () => {
  it('carries its meaning as text with a tone', () => {
    render(<StatusPill tone="danger">failing</StatusPill>);
    expect(screen.getByText('failing').dataset.tone).toBe('danger');
  });

  it('renders keys as <kbd>', () => {
    render(<Kbd>⌘K</Kbd>);
    expect(screen.getByText('⌘K').tagName).toBe('KBD');
  });
});

describe('Skeleton', () => {
  it('is decorative, while the loading region is busy and announced', () => {
    const { container } = render(
      <>
        <Skeleton />
        <SkeletonRows rows={2} label="Loading jobs…" />
      </>,
    );
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Loading jobs…');
  });
});

describe('EmptyState', () => {
  it('states what is missing and the next step', () => {
    render(<EmptyState title="No sources yet." action={<a href="/sources/new">New source</a>} />);
    expect(screen.getByText('No sources yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'New source' })).toBeTruthy();
  });
});

describe('ErrorState', () => {
  it('is an alert with diagnostics and a retry that refreshes the route', () => {
    render(<ErrorState title="API error" message="boom" meta="GET /api/jobs — request req_1" details="{}" />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('request req_1');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('can omit the retry', () => {
    render(<ErrorState title="Not found" message="gone" retry={false} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('PropertyList', () => {
  it('renders label/value pairs, skips null rows and shows — for empty values', () => {
    render(
      <PropertyList
        title="Identity"
        items={[{ label: 'Name', value: 'Acme Ltd' }, null, { label: 'Website', value: '' }]}
      />,
    );
    expect(screen.getByRole('region', { name: 'Identity' })).toBeTruthy();
    const values = [...document.querySelectorAll('dd')].map((d) => d.textContent);
    expect(values).toEqual(['Acme Ltd', '—']);
  });
});

describe('Time', () => {
  const now = new Date('2026-09-29T12:00:00Z');

  it('renders a machine-readable relative time with the UTC timestamp as tooltip', () => {
    render(<Time value="2026-09-29T11:57:00Z" now={now} />);
    const time = screen.getByText('3m ago');
    expect(time.getAttribute('datetime')).toBe('2026-09-29T11:57:00.000Z');
    expect(time.getAttribute('title')).toContain('29 Sep 2026, 11:57 UTC');
  });

  it('shows absolute + relative on record pages and — for missing values', () => {
    render(
      <>
        <Time value="2026-09-12T14:03:00Z" mode="absolute" now={now} />
        <Time value={null} />
      </>,
    );
    expect(screen.getByText(/12 Sep 2026, 14:03 UTC/)).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it.each(['absolute', 'relative'] as const)(
    '%s: hydrates without a mismatch when the client clock differs from the server',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
      const html = renderToString(<Time value="2026-09-29T09:00:00Z" mode={mode} />);
      if (mode === 'absolute') expect(html).not.toContain('ago'); // relative part is client-only
      vi.setSystemTime(new Date('2026-09-29T15:30:00Z')); // hours later on the client
      const container = document.createElement('div');
      container.innerHTML = html;
      document.body.append(container);
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a));
      let root: ReturnType<typeof hydrateRoot> | undefined;
      await act(async () => {
        root = hydrateRoot(container, <Time value="2026-09-29T09:00:00Z" mode={mode} />, {
          onRecoverableError: (e) => errors.push(e),
        });
      });
      spy.mockRestore();
      expect(errors).toEqual([]);
      // After mount it shows the browser's relative time.
      expect(container.textContent).toContain('7h ago');
      act(() => root!.unmount());
      container.remove();
    },
  );
});

describe('CopyButton', () => {
  it('copies the value and announces the result', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<CopyButton value="job_1" label="Copy id" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy id' }));
    });
    expect(writeText).toHaveBeenCalledWith('job_1');
    expect(screen.getByRole('status').textContent).toBe('Copied');
  });

  it('reports a failed copy', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) },
    });
    render(<CopyButton value="x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Copy failed — select the text instead');
    expect(status.className).not.toBe('sr-only'); // visible, not only announced
  });

  it('falls back to a copy command when the Clipboard API is missing (non-secure origin)', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    render(<CopyButton value="job_2" label="Copy id" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy id' }));
    });
    expect(exec).toHaveBeenCalledWith('copy');
    expect(screen.getByRole('status').textContent).toBe('Copied');
    expect(document.querySelector('textarea')).toBeNull(); // cleaned up
  });
});
