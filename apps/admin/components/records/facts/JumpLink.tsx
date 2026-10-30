'use client';

import type { MouseEvent, ReactNode } from 'react';

/**
 * An in-page link (`#section`) from inside a popover: moves focus to the target section (which
 * closes the popover, as focus leaves it) and scrolls it into view, instead of leaving focus on a
 * link in a closed layer.
 */
export function JumpLink({ href, children }: { href: string; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!href.startsWith('#')) return;
    const target = document.getElementById(decodeURIComponent(href.slice(1)));
    if (!target) return;
    e.preventDefault();
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
    history.replaceState(null, '', href);
  };
  return (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  );
}
