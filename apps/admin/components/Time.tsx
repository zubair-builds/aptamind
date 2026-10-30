import { fmtDateTime, fmtRelative } from '@/lib/format';

/** Relative time ("5m ago") with the absolute UTC timestamp on hover; `abs` shows both inline. */
export function RelTime({ iso, abs = false }: { iso: string | null | undefined; abs?: boolean }) {
  if (!iso) return <span className="muted">—</span>;
  const rel = fmtRelative(iso);
  return (
    <time dateTime={iso} title={fmtDateTime(iso)}>
      {abs ? (
        <>
          {fmtDateTime(iso)} <span className="muted">({rel})</span>
        </>
      ) : (
        rel
      )}
    </time>
  );
}
