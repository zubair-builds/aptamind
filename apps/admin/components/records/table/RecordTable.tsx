import Link from 'next/link';
import { PropertyList } from '@/components/ui/PropertyList';
import { Icon } from '@/components/ui/Icon';
import { ariaSort, toggledSort, viewHref, visibleColumns, type ViewState } from '@/lib/views';
import type { ObjectDef } from '../registry/types';
import { RowPeek } from './RowPeek';
import s from './table.module.css';

/**
 * The record table (design system §3): sticky header and identity column, single-line cells,
 * sortable headers that link to the sorted view (`aria-sort`), a preview button per row. The
 * table scrolls inside its own region, never the page.
 */
export function RecordTable<Row>({
  def,
  state,
  rows,
  tableId,
  caption,
}: {
  def: ObjectDef<Row>;
  state: ViewState;
  rows: Row[];
  tableId: string;
  caption: string;
}) {
  const keys = visibleColumns(def, state);
  const cols = keys.map((k) => def.columns.find((c) => c.key === k)!).filter(Boolean);
  return (
    // Focusable so keyboard users can scroll it sideways (WCAG 2.1.1).
    <div id={tableId} className={s.scroller} role="region" aria-label={`${def.label} table`} tabIndex={0}>
      <table className={s.table} data-density={state.density}>
        <caption className="sr-only">
          {caption}. Tab moves between rows; Space previews a row, Enter opens it.
        </caption>
        <thead>
          <tr>
            {cols.map((c) => {
              const sorted = ariaSort(state, c.sort, def.sorts.find((x) => x.key === c.sort)?.natural);
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={sorted}
                  className={
                    [c.identity ? s.identity : '', c.numeric ? s.num : ''].join(' ').trim() || undefined
                  }
                >
                  {c.sort ? (
                    <Link
                      className={s.sortLink}
                      href={viewHref(def, state, { sort: toggledSort(state, c.sort) })}
                      title={`Sort by ${c.label.toLowerCase()}`}
                    >
                      {c.label}
                      {sorted ? (
                        <Icon name={sorted === 'ascending' ? 'arrow-up' : 'arrow-down'} size={12} />
                      ) : null}
                    </Link>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const title = def.rowTitle(row);
            return (
              <tr key={def.rowId(row)}>
                {cols.map((c) =>
                  c.identity ? (
                    <th
                      key={c.key}
                      scope="row"
                      className={c.wrap ? `${s.identity} ${s.identityWrap}` : s.identity}
                      style={c.maxWidth ? { maxWidth: c.maxWidth } : undefined}
                    >
                      <span className={s.identityCell}>
                        <Link href={def.rowHref(row)} className={s.rowLink} data-row-link title={title}>
                          {c.cell(row)}
                        </Link>
                        <span data-row-preview className={s.previewSlot}>
                          <RowPeek name={title}>
                            <div className={s.peek}>
                              <p className={s.peekTitle}>{title}</p>
                              <PropertyList items={def.peek(row)} />
                              <Link href={def.rowHref(row)} className={s.peekOpen}>
                                Open {def.singular} record →
                              </Link>
                            </div>
                          </RowPeek>
                        </span>
                      </span>
                    </th>
                  ) : (
                    <td
                      key={c.key}
                      className={[c.numeric ? s.num : '', c.wrap ? s.wrap : ''].join(' ').trim() || undefined}
                    >
                      <span
                        className={s.cell}
                        data-cell
                        style={c.maxWidth ? { maxWidth: c.maxWidth } : undefined}
                      >
                        {c.cell(row)}
                      </span>
                    </td>
                  ),
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
