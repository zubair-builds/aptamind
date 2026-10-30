'use client';

import Link from 'next/link';
import { type KeyboardEvent, useCallback, useId, useRef, useState } from 'react';
import { type DismissReason, focusQuietly, type Placement, useDismiss, useFloating } from './floating';
import { Icon } from './Icon';
import { Kbd } from './Kbd';
import s from './overlay.module.css';
import b from './Button.module.css';

export type MenuItem =
  | {
      /** Stable key (defaults to the label). */
      id?: string;
      label: string;
      onSelect?: () => void;
      href?: string;
      danger?: boolean;
      disabled?: boolean;
      shortcut?: string;
      /** The current choice (e.g. the active sort): a check mark and `aria-current`. */
      current?: boolean;
    }
  | 'separator';

/**
 * Actions menu (WAI-ARIA menu button). Enter/Space/↓ open on the first item, ↑ on the last;
 * ↑/↓/Home/End move, typing jumps by first letter, Enter/Space activate, Escape closes and
 * returns focus to the button, Tab or focus leaving the menu closes it. Type-ahead ignores
 * Ctrl/Meta/Alt chords.
 */
export function Menu({
  label,
  items,
  buttonLabel,
  placement = 'bottom-end',
}: {
  /** Accessible name of the button (and the menu). */
  label: string;
  items: MenuItem[];
  /** Visible text; omitted = an icon-only "…" button. */
  buttonLabel?: string;
  placement?: Placement;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initial = useRef<'first' | 'last'>('first');
  // Menus with a current choice reserve a check-mark column.
  const checkable = items.some((i) => i !== 'separator' && i.current !== undefined);
  // The first (or last) item is focused once the menu is visible (see useFloating).
  const focusInitial = useCallback((el: HTMLElement) => {
    const all = [...el.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')];
    (initial.current === 'last' ? all.at(-1) : all[0])?.focus();
  }, []);
  useFloating(open, anchor, menu, placement, focusInitial);

  const close = useCallback((reason: DismissReason | 'select' | 'tab') => {
    setOpen(false);
    if (reason === 'escape' || reason === 'select') focusQuietly(button.current);
  }, []);
  useDismiss(open, [anchor, menu], close);

  const enabled = () =>
    [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].filter(
      (el) => el.getAttribute('aria-disabled') !== 'true',
    );

  const openWith = (where: 'first' | 'last') => {
    initial.current = where;
    setOpen(true);
  };

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openWith(e.key === 'ArrowUp' ? 'last' : 'first');
    }
  };

  const onMenuKey = (e: KeyboardEvent) => {
    const list = enabled();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const move = (n: number) => list[(n + list.length) % list.length]?.focus();
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(list.length - 1);
    else if (e.key === 'Tab') return close('tab');
    else if (e.key === ' ' && document.activeElement instanceof HTMLAnchorElement)
      document.activeElement.click();
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const next = [...list.slice(i + 1), ...list.slice(0, i + 1)].find((el) =>
        el.textContent?.trim().toLowerCase().startsWith(k),
      );
      next?.focus();
    } else return;
    e.preventDefault();
  };

  return (
    <span ref={anchor} className={s.anchor}>
      <button
        ref={button}
        type="button"
        className={[b.button, b.sm, buttonLabel ? b.secondary : `${b.ghost} ${b.iconOnly}`].join(' ')}
        aria-label={buttonLabel ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? setOpen(false) : openWith('first'))}
        onKeyDown={onButtonKey}
      >
        {buttonLabel ? (
          <>
            <span>{buttonLabel}</span>
            <Icon name="chevron-down" size={14} />
          </>
        ) : (
          <Icon name="ellipsis" />
        )}
      </button>
      {open ? (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          popover="manual"
          className={s.menu}
          onKeyDown={onMenuKey}
        >
          {items.map((item, i) => {
            if (item === 'separator')
              return <div key={`sep-${i}`} role="separator" className={s.menuSeparator} />;
            const content = (
              <>
                {checkable ? (
                  <span className={s.menuCheck} aria-hidden="true">
                    {item.current ? <Icon name="check" size={14} /> : null}
                  </span>
                ) : null}
                <span className={s.menuLabel}>{item.label}</span>
                {/* Visual hint only: the name stays the label; the shortcut is exposed below. */}
                {item.shortcut ? (
                  <span aria-hidden="true">
                    <Kbd>{item.shortcut}</Kbd>
                  </span>
                ) : null}
              </>
            );
            // aria-keyshortcuts takes chords, not sequences ("c i" would mean c or i).
            const single = item.shortcut && !/\s/.test(item.shortcut.trim());
            const common = {
              role: 'menuitem',
              tabIndex: -1,
              'aria-keyshortcuts': single ? item.shortcut : undefined,
              'aria-description':
                item.shortcut && !single
                  ? `Shortcut: ${item.shortcut.trim().split(/\s+/).join(' then ')}`
                  : undefined,
              className: s.menuItem,
              'aria-disabled': item.disabled || undefined,
              'aria-current': item.current ? ('true' as const) : undefined,
              'data-danger': item.danger || undefined,
            } as const;
            if (item.href && !item.disabled)
              return (
                <Link
                  key={item.id ?? item.label}
                  href={item.href}
                  {...common}
                  onClick={() => close('select')}
                >
                  {content}
                </Link>
              );
            return (
              <button
                key={item.id ?? item.label}
                type="button"
                {...common}
                onClick={() => {
                  if (item.disabled) return;
                  item.onSelect?.();
                  close('select');
                }}
              >
                {content}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
