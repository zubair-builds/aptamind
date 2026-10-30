import type { ReactNode } from 'react';
import { Empty } from './Empty';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  numeric?: boolean;
  className?: string;
}

/** Semantic, dense data table. `caption` is visually hidden unless `showCaption`. */
export function DataTable<T>({
  columns,
  rows,
  caption,
  showCaption = false,
  empty,
  rowKey,
  rowClassName,
}: {
  columns: Array<Column<T> | null | false>;
  rows: T[];
  caption: string;
  showCaption?: boolean;
  empty?: ReactNode;
  rowKey?: (row: T, index: number) => string;
  rowClassName?: (row: T) => string | undefined;
}) {
  const cols = columns.filter((c): c is Column<T> => !!c);
  if (rows.length === 0) return <Empty>{empty ?? `No ${caption.toLowerCase()}.`}</Empty>;
  return (
    // A named, focusable region: it scrolls sideways on phones and must be keyboard-scrollable
    // (axe scrollable-region-focusable, WCAG 2.1.1).
    <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="table">
        <caption className={showCaption ? undefined : 'sr-only'}>{caption}</caption>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} scope="col" className={c.numeric ? 'num' : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey ? rowKey(row, i) : i} className={rowClassName?.(row)}>
              {cols.map((c) => (
                <td
                  key={c.key}
                  className={[c.numeric ? 'num' : '', c.className ?? ''].join(' ').trim() || undefined}
                >
                  {c.cell(row, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
