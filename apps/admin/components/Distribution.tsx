import { fmtNum } from '@/lib/format';

/**
 * Counts by category as a table with a single-hue magnitude bar (one series, so no legend;
 * the numbers are always printed so the bar never carries meaning alone).
 */
export function Distribution({
  title,
  counts,
  emptyLabel = 'No data.',
}: {
  title: string;
  counts: Record<string, number>;
  emptyLabel?: string;
}) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, [, n]) => a + n, 0);
  const max = rows.reduce((a, [, n]) => Math.max(a, n), 0);
  return (
    <div className="dist">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="empty">{emptyLabel}</p>
      ) : (
        <table className="table table-dist">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">Value</th>
              <th scope="col" className="num">
                Count
              </th>
              <th scope="col" className="num">
                Share
              </th>
              <th scope="col">
                <span className="sr-only">Bar</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, n]) => (
              <tr key={k}>
                <td>
                  {k === 'unknown' || k === 'null' ? (
                    <span className="muted">{k}</span>
                  ) : (
                    k.replace(/_/g, ' ')
                  )}
                </td>
                <td className="num">{fmtNum(n)}</td>
                <td className="num muted">{total ? `${((n / total) * 100).toFixed(0)}%` : '—'}</td>
                <td className="bar-cell" aria-hidden="true">
                  <span className="bar" style={{ width: `${max ? Math.max(2, (n / max) * 100) : 0}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
