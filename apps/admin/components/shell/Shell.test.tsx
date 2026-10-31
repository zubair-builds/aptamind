// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavItem } from './NavItem';
import { Shell, SidebarToggle } from './Shell';
import { ThemeSwitch } from './ThemeSwitch';

const nav = vi.hoisted(() => ({ pathname: '/jobs' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

let desktop = true;
beforeEach(() => {
  desktop = true;
  nav.pathname = '/jobs';
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: desktop,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  document.cookie = 'aptamind-sidebar=; Max-Age=0; Path=/';
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const shellUi = (initialCollapsed = false) => (
  <Shell
    initialCollapsed={initialCollapsed}
    actions={null}
    chip={<a href="/settings/system">Internal · password protected</a>}
    notice={null}
    sidebar={
      <>
        <SidebarToggle />
        <nav aria-label="Main">
          <ul>
            <NavItem href="/" label="Home" icon={null} />
            <NavItem href="/jobs" label="Jobs" icon={null} />
            <NavItem href="/runs" label="Runs" icon={null} also={['/node-runs']} />
          </ul>
        </nav>
      </>
    }
  >
    <h1>Page</h1>
    <input aria-label="Search" />
  </Shell>
);
const renderShell = (initialCollapsed = false) => render(shellUi(initialCollapsed));

describe('navigation', () => {
  it('marks only the current section with aria-current', () => {
    renderShell();
    expect(screen.getByRole('link', { name: 'Jobs' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
  });

  it('keeps a section active on its related routes', () => {
    nav.pathname = '/node-runs/nrun_1';
    renderShell();
    const main = within(screen.getByRole('navigation', { name: 'Main' }));
    expect(main.getByRole('link', { name: 'Runs' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows breadcrumbs for the current route', () => {
    nav.pathname = '/jobs/job_1';
    renderShell();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs.textContent).toContain('Jobs');
    expect(screen.getByText('job_1').getAttribute('aria-current')).toBe('page');
  });
});

describe('drawer', () => {
  it('opens from the menu button and closes on Escape, returning focus', async () => {
    desktop = false;
    const { container } = renderShell();
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-drawer="open"]')).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);
  });

  it('closes when the route changes', () => {
    desktop = false;
    const view = renderShell();
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    nav.pathname = '/runs';
    view.rerender(shellUi());
    expect(menu.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('drawer as a modal', () => {
  it('is a labelled modal dialog while open, with the page, top bar and skip link inert', () => {
    desktop = false;
    const { container } = renderShell();
    const aside = container.querySelector('aside')!;
    expect(aside.getAttribute('aria-label')).toBe('Sidebar');
    expect(aside.getAttribute('role')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(aside.getAttribute('role')).toBe('dialog');
    expect(aside.getAttribute('aria-modal')).toBe('true');
    expect(aside.getAttribute('aria-label')).toBe('Navigation');
    expect(container.querySelector('main')!.parentElement!.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('a[href="#main"]')!.hasAttribute('inert')).toBe(true);
  });

  it('`[` closes an open drawer and returns focus to the menu button', async () => {
    desktop = false;
    renderShell();
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(menu);
    await act(async () => {
      fireEvent.keyDown(document, { key: '[' });
    });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);
  });

  it('moves focus to main after a navigation closes it', () => {
    desktop = false;
    const view = renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    nav.pathname = '/runs';
    view.rerender(shellUi());
    expect(document.activeElement?.id).toBe('main');
  });
});

describe('shortcut guard', () => {
  it('ignores `[` on key repeat, when already handled, or under an open modal dialog', () => {
    renderShell();
    fireEvent.keyDown(document, { key: '[', repeat: true });
    const handled = new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    fireEvent.keyDown(document, { key: '[' });
    dialog.remove();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeTruthy();
  });

  it('ignores `[` in text boxes and comboboxes', () => {
    renderShell();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search' }), { key: '[' });
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeTruthy();
  });
});

describe('collapse', () => {
  it('toggles with the button and with `[`, persisting the choice in a cookie', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(document.cookie).toContain('aptamind-sidebar=collapsed');
    const expand = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(document, { key: '[' });
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeTruthy();
    expect(document.cookie).toContain('aptamind-sidebar=expanded');
  });
});

describe('ThemeSwitch', () => {
  it('pins light/dark on <html> and clears it for system', () => {
    render(<ThemeSwitch initial="system" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.cookie).toContain('aptamind-theme=dark');
    fireEvent.click(screen.getByRole('radio', { name: 'System theme' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(screen.getByRole('radio', { name: 'System theme' })).toHaveProperty('checked', true);
  });
});
