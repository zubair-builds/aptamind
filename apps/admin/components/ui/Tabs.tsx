'use client';

import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import s from './Tabs.module.css';

export interface TabItem {
  id: string;
  label: string;
  /** Optional count shown after the label. */
  count?: number;
  content: ReactNode;
}

/**
 * Tabs (WAI-ARIA, automatic activation): one tab stop, ←/→ and Home/End move and select.
 * Every panel is rendered (inactive ones `hidden`), so each tab's `aria-controls` resolves.
 */
export function Tabs({
  label,
  tabs,
  value,
  defaultValue,
  onChange,
}: {
  label: string;
  tabs: TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
}) {
  const base = useId();
  const [own, setOwn] = useState(defaultValue ?? tabs[0]?.id);
  const selected = value ?? own;
  const list = useRef<HTMLDivElement>(null);

  const select = (id: string, focus = false) => {
    if (value === undefined) setOwn(id);
    onChange?.(id);
    if (focus) list.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"]`)?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === selected);
    const to =
      e.key === 'ArrowRight'
        ? (i + 1) % tabs.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + tabs.length) % tabs.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    select(tabs[to]!.id, true);
  };

  return (
    <div className={s.tabs}>
      <div ref={list} role="tablist" aria-label={label} className={s.list} onKeyDown={onKey}>
        {tabs.map((t) => {
          const active = t.id === selected;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              data-tab={t.id}
              aria-selected={active}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={active ? 0 : -1}
              className={s.tab}
              onClick={() => select(t.id)}
            >
              {t.label}
              {t.count !== undefined ? <span className={s.count}>{t.count}</span> : null}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          tabIndex={0}
          hidden={t.id !== selected}
          className={s.panel}
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}
