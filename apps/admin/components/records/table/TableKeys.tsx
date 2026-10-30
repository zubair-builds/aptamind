'use client';

import { useEffect } from 'react';
import { shortcutAllowed } from '@/components/shell/Shell';
import { focusQuietly } from '@/components/ui/floating';

/** A cell's visible text for its tooltip: no screen-reader-only text, words kept apart. */
function visibleText(cell: HTMLElement) {
  const copy = cell.cloneNode(true) as HTMLElement;
  for (const n of copy.querySelectorAll('.sr-only')) n.remove();
  for (const n of copy.querySelectorAll('*')) n.append(' ');
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * List keyboard and cell behaviour (design system §3, §8):
 * - One Tab stop per row: the row's name link. Other controls in a row (preview button, links in
 *   cells) leave the Tab order; `Space` or `p` on a row opens its preview, which repeats the
 *   row's properties and links.
 * - `j`/`k` move to the next/previous row from anywhere on the list, `↓`/`↑` while focus is in
 *   the table; never inside an open popover or menu. `Enter` opens the record (a normal link).
 * - `/` focuses the list search.
 * - A cell whose text is cut off gets its full text as a tooltip.
 */
export function TableKeys({ tableId, searchId }: { tableId: string; searchId: string }) {
  useEffect(() => {
    const table = document.getElementById(tableId);
    if (!table) return;

    // One Tab stop per row.
    for (const el of table.querySelectorAll<HTMLElement>('tbody a[href], tbody button')) {
      if (!el.hasAttribute('data-row-link')) el.tabIndex = -1;
    }

    // Back from a record (Enter, then Back): focus the row that was opened, if it is still here.
    const storeKey = `aptamind:list-row:${location.pathname}`;
    try {
      const href = sessionStorage.getItem(storeKey);
      sessionStorage.removeItem(storeKey);
      const again = href
        ? [...table.querySelectorAll<HTMLElement>('[data-row-link]')].find(
            (l) => l.getAttribute('href') === href,
          )
        : undefined;
      if (again && (document.activeElement === document.body || document.activeElement === null)) {
        focusQuietly(again);
        again.scrollIntoView({ block: 'nearest' });
      }
    } catch {
      /* storage unavailable: nothing to restore */
    }
    const remember = (e: MouseEvent) => {
      // Only a plain click opens the record here; modified clicks open another tab or window.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target instanceof HTMLElement ? e.target.closest('[data-row-link]') : null;
      if (!link) return;
      try {
        sessionStorage.setItem(storeKey, link.getAttribute('href') ?? '');
      } catch {
        /* storage unavailable */
      }
    };
    table.addEventListener('click', remember);

    // Full text for truncated cells.
    const titled = new Set<HTMLElement>();
    const updateTitles = () => {
      for (const cell of table.querySelectorAll<HTMLElement>('[data-cell]')) {
        const cut = cell.scrollWidth > cell.clientWidth + 1;
        if (cut) {
          cell.title = visibleText(cell);
          titled.add(cell);
        } else if (titled.has(cell)) {
          cell.removeAttribute('title');
          titled.delete(cell);
        }
      }
    };
    updateTitles();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateTitles);
    resize?.observe(table);

    const onKey = (e: KeyboardEvent) => {
      if (!shortcutAllowed(e)) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      // Keys inside an open layer (filter panel, preview, sort menu) belong to that layer.
      if (target?.closest('[role="dialog"], [role="menu"]')) return;
      if (e.key === '/') {
        const search = document.getElementById(searchId);
        if (search instanceof HTMLInputElement) {
          e.preventDefault();
          search.focus();
          search.select();
        }
        return;
      }
      const inside = table.contains(document.activeElement);
      const row = inside ? (document.activeElement as HTMLElement).closest('tr') : null;
      if (row && (e.key === ' ' || e.key === 'p')) {
        const preview = row.querySelector<HTMLButtonElement>('[data-row-preview] button');
        if (preview) {
          e.preventDefault();
          preview.click();
        }
        return;
      }
      const down = e.key === 'j' || (inside && e.key === 'ArrowDown');
      const up = e.key === 'k' || (inside && e.key === 'ArrowUp');
      if (!down && !up) return;
      const links = [...table.querySelectorAll<HTMLElement>('[data-row-link]')];
      if (!links.length) return;
      const i = links.findIndex((l) => l.closest('tr') === row);
      const next =
        i < 0 ? (down ? 0 : links.length - 1) : Math.min(links.length - 1, Math.max(0, i + (down ? 1 : -1)));
      e.preventDefault();
      links[next]!.focus();
      links[next]!.scrollIntoView({ block: 'nearest' });
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      table.removeEventListener('click', remember);
      resize?.disconnect();
    };
  }, [tableId, searchId]);
  return null;
}
