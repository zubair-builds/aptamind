'use client';

import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { SIDEBAR_COOKIE, writePreference } from '@/lib/preferences';
import { Breadcrumbs } from './Breadcrumbs';
import s from './Shell.module.css';

/** Sidebar is a drawer below this width (design system §1 breakpoints). */
const DESKTOP = '(min-width: 1024px)';

interface ShellState {
  collapsed: boolean;
  toggleCollapsed: () => void;
  closeDrawer: () => void;
}

const ShellContext = createContext<ShellState>({
  collapsed: false,
  toggleCollapsed: () => {},
  closeDrawer: () => {},
});

export const useShell = () => useContext(ShellContext);

/** Single-key shortcuts never fire while typing, on repeat, when handled, or under a modal dialog. */
export function shortcutAllowed(e: KeyboardEvent) {
  if (e.defaultPrevented || e.repeat || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;
  const el = e.target instanceof HTMLElement ? e.target : null;
  if (
    el?.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"]',
    )
  )
    return false;
  if (el?.isContentEditable) return false;
  return !document.querySelector('dialog[open]');
}

/**
 * App frame: sidebar (collapsible rail on desktop, drawer below 1024 px), top bar with
 * breadcrumbs, page actions and the no-auth chip, and the main landmark.
 */
export function Shell({
  sidebar,
  actions,
  chip,
  notice,
  initialCollapsed,
  children,
}: {
  sidebar: ReactNode;
  actions: ReactNode;
  chip: ReactNode;
  notice: ReactNode;
  initialCollapsed: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  // Any navigation (link, back/forward) closes the drawer.
  // ...and moves focus to the new page's main landmark.
  const pathname = usePathname();
  const [shownPath, setShownPath] = useState(pathname);
  const focusMain = useRef(false);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    if (drawerOpen) {
      focusMain.current = true;
      setDrawerOpen(false);
    }
  }

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      writePreference(SIDEBAR_COOKIE, c ? 'expanded' : 'collapsed');
      return !c;
    });
  }, []);

  // Focus returns to the menu button once the content is no longer inert (after the commit).
  const restoreFocus = useRef(false);
  const closeDrawer = useCallback(() => {
    restoreFocus.current = true;
    setDrawerOpen(false);
  }, []);
  useEffect(() => {
    if (drawerOpen) return;
    if (restoreFocus.current) menuButton.current?.focus();
    else if (focusMain.current) document.getElementById('main')?.focus({ preventScroll: true });
    restoreFocus.current = false;
    focusMain.current = false;
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    sidebarRef.current?.querySelector<HTMLElement>('[data-drawer-focus]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    const desktop = window.matchMedia(DESKTOP);
    const onResize = () => desktop.matches && setDrawerOpen(false);
    document.addEventListener('keydown', onKey);
    desktop.addEventListener('change', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      desktop.removeEventListener('change', onResize);
    };
  }, [drawerOpen, closeDrawer]);

  // `[` toggles the sidebar (collapse on desktop, drawer below).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' || !shortcutAllowed(e)) return;
      e.preventDefault();
      if (drawerOpen) closeDrawer();
      else if (window.matchMedia(DESKTOP).matches) toggleCollapsed();
      else setDrawerOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen, closeDrawer, toggleCollapsed]);

  return (
    <ShellContext.Provider value={{ collapsed, toggleCollapsed, closeDrawer }}>
      <div
        className={s.shell}
        data-collapsed={collapsed || undefined}
        data-drawer={drawerOpen ? 'open' : undefined}
      >
        {/* Inert while the drawer is open, so the modal drawer cannot be escaped. */}
        <a className={s.skipLink} href="#main" inert={drawerOpen}>
          Skip to content
        </a>
        <aside
          id="app-sidebar"
          ref={sidebarRef}
          className={s.sidebar}
          aria-label={drawerOpen ? 'Navigation' : 'Sidebar'}
          {...(drawerOpen ? { role: 'dialog', 'aria-modal': true } : {})}
        >
          {sidebar}
        </aside>
        {drawerOpen ? <div className={s.scrim} onClick={closeDrawer} aria-hidden="true" /> : null}
        <div className={s.content} inert={drawerOpen}>
          <header className={s.topbar}>
            <button
              ref={menuButton}
              type="button"
              className={`${s.iconButton} ${s.menuButton}`}
              aria-label="Open navigation"
              aria-controls="app-sidebar"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <Breadcrumbs />
            <div className={s.actions}>{actions}</div>
            {chip}
          </header>
          {notice}
          <main id="main" tabIndex={-1} className={s.main}>
            {children}
          </main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}

/** Collapse/expand on desktop; close button when the sidebar is a drawer. */
export function SidebarToggle() {
  const { collapsed, toggleCollapsed, closeDrawer } = useShell();
  return (
    <>
      <button
        type="button"
        className={`${s.iconButton} ${s.collapseButton}`}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-controls="app-sidebar"
        aria-expanded={!collapsed}
        title={`${collapsed ? 'Expand' : 'Collapse'} sidebar ( [ )`}
        onClick={toggleCollapsed}
      >
        {/* Collapsed, the workspace logo itself is the expand control. */}
        {collapsed ? (
          <span className={s.logo} aria-hidden="true">
            A
          </span>
        ) : (
          <Icon name="panel-left-close" />
        )}
      </button>
      <button
        type="button"
        className={`${s.iconButton} ${s.closeButton}`}
        aria-label="Close navigation"
        data-drawer-focus
        onClick={closeDrawer}
      >
        <Icon name="x" />
      </button>
    </>
  );
}
