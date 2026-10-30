'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Wraps a page's top-bar actions (app/@actions/<route>/page.tsx). On soft navigation Next keeps
 * the last matched slot content for routes the slot does not define, so actions render only
 * while their own route is showing.
 */
export function PageActions({ path, children }: { path: string; children: ReactNode }) {
  return usePathname() === path ? <>{children}</> : null;
}
