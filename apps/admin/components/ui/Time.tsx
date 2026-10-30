'use client';

import { useSyncExternalStore } from 'react';
import { absoluteLabel, relativeLabel } from './time-format';
import s from './Time.module.css';

/*
 * The browser's clock, ticking once a minute. The server snapshot is null, so hydration renders
 * exactly what the server sent and the relative text appears (or updates) only after mount;
 * server and client never compute "now" for the same render.
 */
let clientNow: number | null = null;
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | undefined;

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!ticker)
    ticker = setInterval(() => {
      clientNow = Date.now();
      listeners.forEach((l) => l());
    }, 60_000);
  return () => {
    listeners.delete(cb);
    if (!listeners.size) {
      clearInterval(ticker);
      ticker = undefined;
      clientNow = null;
    }
  };
}
const getSnapshot = () => (clientNow ??= Date.now());
const getServerSnapshot = () => null;

const localFormat = (d: Date) => d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * `<time dateTime>` as relative text (lists) or absolute UTC + relative (record pages). The
 * tooltip always shows UTC and, once in the browser, the viewer's local time.
 *
 * Relative mode renders the server's relative text (the one text node, hydration-tolerant) and
 * re-renders it from the browser clock after mount. Absolute mode renders only the absolute UTC text on
 * the server; its "· 3h ago" suffix appears after mount, so it can never mismatch.
 */
export function Time({
  value,
  mode = 'relative',
  now,
}: {
  value: string | Date | null | undefined;
  mode?: 'relative' | 'absolute';
  /** Fixed "now" (tests, catalogue): rendered identically on server and client. */
  now?: Date;
}) {
  const browserNow = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const date = value ? new Date(value) : null;
  const valid = date && !Number.isNaN(date.getTime());
  if (!date || !valid) return <span className={s.empty}>—</span>;
  const iso = date.toISOString();
  const abs = absoluteLabel(date);
  const mounted = browserNow !== null;
  const reference = now ?? (mounted ? new Date(browserNow) : null);
  const title = mounted ? `${abs}\n${localFormat(date)} (local)` : abs;
  if (mode === 'absolute') {
    return (
      <time dateTime={iso} title={title} suppressHydrationWarning>
        {abs}
        {reference ? <span className={s.secondary}> · {relativeLabel(date, reference)}</span> : null}
      </time>
    );
  }
  // The key changes once mounted: React keeps a hydrated text node it was told to tolerate even
  // when the browser's text differs, so the element is replaced to show the browser's value.
  return (
    <time key={mounted ? 'client' : 'server'} dateTime={iso} title={title} suppressHydrationWarning>
      {relativeLabel(date, reference ?? new Date())}
    </time>
  );
}
