'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { crumbsFor } from '@/lib/breadcrumbs';
import s from './Shell.module.css';

export function Breadcrumbs() {
  const crumbs = crumbsFor(usePathname() ?? '/');
  if (!crumbs.length) return <div className={s.crumbs} />;
  return (
    <nav aria-label="Breadcrumb" className={s.crumbs}>
      <ol>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${i}-${c.label}`} className={last ? s.crumbCurrent : undefined}>
              {i > 0 ? (
                <span className={s.crumbSep} aria-hidden="true">
                  ›
                </span>
              ) : null}
              {c.href && !last ? (
                <Link href={c.href}>{c.label}</Link>
              ) : (
                <span
                  className={c.mono ? s.crumbMono : undefined}
                  aria-current={last ? 'page' : undefined}
                  title={c.mono ? c.label : undefined}
                >
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
