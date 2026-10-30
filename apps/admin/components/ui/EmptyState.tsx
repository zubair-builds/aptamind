import type { ReactNode } from 'react';
import s from './States.module.css';

/** One sentence plus the next step ("No sources yet · New source"); no illustrations. */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={s.empty}>
      <p className={s.emptyTitle}>{title}</p>
      {description ? <p className={s.emptyText}>{description}</p> : null}
      {action ? <div className={s.actions}>{action}</div> : null}
    </div>
  );
}
