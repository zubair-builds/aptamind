import type { ReactNode } from 'react';
import s from './PropertyList.module.css';

export interface Property {
  label: ReactNode;
  value: ReactNode;
}

const isEmpty = (v: ReactNode) => v === null || v === undefined || v === false || v === '';

/** Label | value rows (160 px label column, wraps on phones). Empty values render as "—". */
export function PropertyList({
  items,
  title,
}: {
  items: Array<Property | null | false | undefined>;
  title?: string;
}) {
  const rows = items.filter((p): p is Property => !!p);
  return (
    <section className={s.group} aria-label={title}>
      {title ? <h3 className={s.title}>{title}</h3> : null}
      <dl className={s.list}>
        {rows.map((p, i) => (
          <div key={i} className={s.row}>
            <dt className={s.label}>{p.label}</dt>
            <dd className={s.value}>{isEmpty(p.value) ? <span className={s.empty}>—</span> : p.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
