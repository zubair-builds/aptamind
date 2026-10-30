import type { ReactNode } from 'react';
import s from './StatusPill.module.css';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

/** Status as dot + text. The text always carries the meaning; colour only reinforces it. */
export function StatusPill({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: StatusTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={s.pill} data-tone={tone} title={title}>
      <span className={s.dot} aria-hidden="true" />
      {children}
    </span>
  );
}
