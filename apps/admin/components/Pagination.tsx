import Link from 'next/link';

type Params = Record<string, string | undefined>;

function href(pathname: string, params: Params, offset: number, limit: number): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== '' && k !== 'offset' && k !== 'limit') q.set(k, v);
  if (offset > 0) q.set('offset', String(offset));
  q.set('limit', String(limit));
  return `${pathname}?${q.toString()}`;
}

/** limit/offset pagination driven by the API's `total`. */
export function Pagination({
  total,
  limit,
  offset,
  pathname,
  params,
}: {
  total: number;
  limit: number;
  offset: number;
  pathname: string;
  params: Params;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const prev = offset > 0 ? Math.max(0, offset - limit) : null;
  const next = offset + limit < total ? offset + limit : null;
  const lastOffset = total > 0 ? Math.floor((total - 1) / limit) * limit : 0;
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="muted">
        {from.toLocaleString('en-GB')}–{to.toLocaleString('en-GB')} of {total.toLocaleString('en-GB')}
      </span>
      <span className="pagination-links">
        {prev !== null ? (
          <Link href={href(pathname, params, 0, limit)}>« First</Link>
        ) : (
          <span className="disabled">« First</span>
        )}
        {prev !== null ? (
          <Link href={href(pathname, params, prev, limit)}>‹ Prev</Link>
        ) : (
          <span className="disabled">‹ Prev</span>
        )}
        {next !== null ? (
          <Link href={href(pathname, params, next, limit)}>Next ›</Link>
        ) : (
          <span className="disabled">Next ›</span>
        )}
        {next !== null ? (
          <Link href={href(pathname, params, lastOffset, limit)}>Last »</Link>
        ) : (
          <span className="disabled">Last »</span>
        )}
      </span>
    </nav>
  );
}
