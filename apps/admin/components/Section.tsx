import type { ReactNode } from 'react';

export function Section({
  title,
  id,
  actions,
  children,
  description,
}: {
  title: ReactNode;
  id?: string;
  actions?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section" id={id} aria-labelledby={id ? `${id}-title` : undefined}>
      <div className="section-head">
        <h2 id={id ? `${id}-title` : undefined}>{title}</h2>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </div>
      {description ? <p className="section-desc">{description}</p> : null}
      {children}
    </section>
  );
}

/** Compact key/value definition list. */
export function KV({ items }: { items: Array<[ReactNode, ReactNode] | null | false | undefined> }) {
  return (
    <dl className="kv">
      {items
        .filter((x): x is [ReactNode, ReactNode] => !!x)
        .map(([k, v], i) => (
          <div className="kv-row" key={i}>
            <dt>{k}</dt>
            <dd>{v === null || v === undefined || v === '' ? <span className="muted">—</span> : v}</dd>
          </div>
        ))}
    </dl>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <div className="page-subtitle">{subtitle}</div> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'ok' | 'warn' | 'bad';
}) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}
