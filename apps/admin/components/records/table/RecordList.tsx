import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ApiErrorPanel } from '@/components/ApiError';
import { EmptyState } from '@/components/ui/EmptyState';
import { apiGet } from '@/lib/api';
import type { ListPage } from '@/lib/types';
import {
  apiQuery,
  canonicalHref,
  isModified,
  parseView,
  presetState,
  prevOffsetHref,
  prevPageHref,
  viewHref,
  type RawParams,
} from '@/lib/views';
import type { ObjectDef } from '../registry/types';
import { Pager, pageRange } from './Pager';
import { RecordTable } from './RecordTable';
import { TableKeys } from './TableKeys';
import { ViewBar } from './ViewBar';
import s from './table.module.css';

/**
 * A record list page body: parse the URL view, ask the list API for exactly that page
 * (server-side, keyset), then the view bar, the table (or the empty / error state) and the pager.
 */
export async function RecordList<Row>({
  def,
  params,
  suggestions,
}: {
  def: ObjectDef<Row>;
  params: RawParams;
  suggestions?: Record<string, string[]>;
}) {
  const state = parseView(def, params);
  // GET forms submit empty fields and repeated keys: answer with the canonical URL instead.
  const canonical = canonicalHref(def, params, state);
  if (canonical) redirect(canonical);
  const res = await apiGet<ListPage<Row>>(def.apiPath, apiQuery(def, state));
  const rows = res.ok ? res.data.items : [];
  // Lists without a count (imports) omit `total`: treat that as unknown.
  const total = res.ok ? (res.data.total ?? null) : null;
  const tableId = `${def.key}-table`;
  const searchId = `${def.key}-search`;
  const filtered = state.q !== '' || Object.keys(state.filters).length > 0;
  return (
    <div className={s.list}>
      <ViewBar def={def} state={state} rows={rows} searchId={searchId} suggestions={suggestions} />
      {!res.ok ? (
        <>
          <ApiErrorPanel error={res.error} />
          {state.after ? (
            <p className={s.formNote}>
              A page cursor expires when the list changes shape.{' '}
              <Link href={viewHref(def, state, { after: null, prev: [] })}>Back to the first page</Link>
            </p>
          ) : null}
        </>
      ) : rows.length === 0 && state.offset > 0 && total !== null && total > 0 ? (
        // An offset past the end (a stale or hand-made URL): say how many there are, offer the last page.
        <EmptyState
          title={`No rows at this offset: ${total} ${def.label.toLowerCase()} in total.`}
          action={
            <span className={s.pagerLinks}>
              <Link href={viewHref(def, state, { offset: 0 })}>First page</Link>
              <Link
                href={viewHref(def, state, {
                  offset: Math.floor((total - 1) / state.limit) * state.limit,
                })}
              >
                Last page
              </Link>
            </span>
          }
        />
      ) : rows.length === 0 && (state.after || state.offset > 0) ? (
        // A page that emptied after paging (rows moved or were closed meanwhile).
        <EmptyState
          title="No more rows."
          action={
            <span className={s.pagerLinks}>
              <Link href={viewHref(def, state, { after: null, prev: [], offset: 0 })}>First page</Link>
              {(state.after ? prevPageHref(def, state) : prevOffsetHref(def, state)) ? (
                <Link href={(state.after ? prevPageHref(def, state) : prevOffsetHref(def, state))!}>
                  ← Previous
                </Link>
              ) : null}
            </span>
          }
        />
      ) : rows.length === 0 &&
        !isModified(def, state) &&
        def.views.find((v) => v.id === state.view)?.empty ? (
        // The unmodified system view has its own sentence ("No resolved items yet.").
        <EmptyState title={def.views.find((v) => v.id === state.view)!.empty!} />
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            title={`No ${def.label.toLowerCase()} match these filters.`}
            action={
              // Clearing keeps the current system view; an unmodified empty view links to the base one.
              isModified(def, state) ? (
                <Link
                  href={viewHref(def, {
                    ...presetState(def, state.view),
                    cols: state.cols,
                    density: state.density,
                  })}
                >
                  Clear filters
                </Link>
              ) : (
                <Link
                  href={viewHref(def, {
                    ...presetState(def, def.views[0]!.id),
                    cols: state.cols,
                    density: state.density,
                  })}
                >
                  Show {def.views[0]!.label.toLowerCase()}
                </Link>
              )
            }
          />
        ) : (
          <EmptyState title={def.emptyAll} />
        )
      ) : (
        <>
          <RecordTable
            def={def}
            state={state}
            rows={rows}
            tableId={tableId}
            caption={`${def.label}, rows ${pageRange(state, rows.length, total)}`}
          />
          <Pager def={def} state={state} shown={rows.length} total={total} nextCursor={res.data.nextCursor} />
          {/* Keyed by the view: Next keeps this segment mounted across search-param changes, so the
              effect must run again for the new rows (Tab stops, cut-cell tooltips). */}
          <TableKeys key={viewHref(def, state)} tableId={tableId} searchId={searchId} />
        </>
      )}
    </div>
  );
}
