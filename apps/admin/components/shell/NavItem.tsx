'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useShell } from './Shell';
import s from './Shell.module.css';

export function isActive(pathname: string, href: string, also: readonly string[] = []) {
  if (href === '/') return pathname === '/';
  return [href, ...also].some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Sidebar link: icon + label (visually hidden when collapsed) + optional trailing count/status. */
export function NavItem({
  href,
  label,
  icon,
  also,
  trailing,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  /** Other path prefixes that belong to this item (e.g. node runs under Runs). */
  also?: readonly string[];
  trailing?: ReactNode;
}) {
  const active = isActive(usePathname() ?? '/', href, also);
  const { collapsed } = useShell();
  return (
    <li>
      <Link
        href={href}
        className={s.navItem}
        aria-current={active ? 'page' : undefined}
        title={collapsed ? label : undefined}
      >
        <span className={s.navIcon}>{icon}</span>
        <span className={s.navLabel}>{label}</span>
        {trailing ? <span className={s.navTrailing}>{trailing}</span> : null}
      </Link>
    </li>
  );
}
