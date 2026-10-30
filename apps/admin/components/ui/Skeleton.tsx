import type { CSSProperties } from 'react';
import s from './Skeleton.module.css';

/**
 * Placeholder shaped like the content that is loading. Decorative: the loading region itself
 * carries `aria-busy` and a text status.
 */
export function Skeleton({
  width = '100%',
  height = 12,
}: {
  width?: number | string;
  height?: number | string;
}) {
  const style: CSSProperties = { width, height };
  return <span className={s.skeleton} style={style} aria-hidden="true" />;
}

/** `rows` skeleton rows (e.g. a table body while it loads). */
export function SkeletonRows({ rows = 10, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <div className={s.rows} aria-busy="true">
      <span className="sr-only" role="status">
        {label}
      </span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={s.row}>
          <Skeleton width="28%" />
          <Skeleton width="18%" />
          <Skeleton width="14%" />
          <Skeleton width="22%" />
        </div>
      ))}
    </div>
  );
}
