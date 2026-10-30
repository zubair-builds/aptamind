'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * The view-tab strip. On narrow screens it scrolls sideways; the current (or modified) tab is
 * scrolled into view whenever the view changes, horizontally only (the page does not move).
 */
export function ViewTabs({
  label,
  className,
  current,
  children,
}: {
  label: string;
  className?: string;
  /** The current view id: the effect re-runs when it changes. */
  current: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = ref.current;
    const tab = nav?.querySelector<HTMLElement>('[aria-current="page"], [data-modified]');
    if (!nav || !tab || nav.scrollWidth <= nav.clientWidth) return;
    const left = tab.offsetLeft - nav.offsetLeft;
    const right = left + tab.offsetWidth;
    // Leave room for the fade at the right edge.
    const pad = 48;
    if (left < nav.scrollLeft) nav.scrollLeft = Math.max(0, left - 16);
    else if (right > nav.scrollLeft + nav.clientWidth - pad) nav.scrollLeft = right - nav.clientWidth + pad;
  }, [current]);
  return (
    <nav ref={ref} className={className} aria-label={label}>
      {children}
    </nav>
  );
}
