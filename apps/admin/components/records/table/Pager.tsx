import Link from 'next/link';
import { fmtNum } from '@/lib/format';
import {
  nextOffsetHref,
  nextPageHref,
  pageOffset,
  PAGE_SIZES,
  prevOffsetHref,
  prevPageHref,
  rowsNumbered,
  viewHref,
  type ViewState,
} from '@/lib/views';
import type { ObjectDef } from '../registry/types';
import s from './table.module.css';

/** "1–50 of 1,234" (or "51–100" when paging without a count) with keyset Prev / Next. */
export function pageRange(state: ViewState, shown: number, total: number | null) {
  // Past the kept trail of cursors the page number is unknown: say how many rows, not which.
  if (!rowsNumbered(state)) return `${fmtNum(shown)} rows · page ${state.prev.length + 1}+`;
  const start = pageOffset(state);
  const range = shown ? `${fmtNum(start + 1)}–${fmtNum(start + shown)}` : '0';
  return total === null ? range : `${range} of ${fmtNum(total)}`;
}

/** Rows per page (10/25/50/100); changing it starts from the first page. */
function PageSizes<Row>({ def, state }: { def: ObjectDef<Row>; state: ViewState }) {
  return (
    <span className={s.pageSizes} aria-label="Rows per page" role="group">
      Rows per page:{' '}
      {PAGE_SIZES.map((n) =>
        n === state.limit ? (
          <span key={n} aria-current="true" className={s.pageSizeCurrent}>
            {n}
          </span>
        ) : (
          <Link key={n} href={viewHref(def, state, { limit: n, after: null, prev: [], offset: 0 })}>
            {n}
          </Link>
        ),
      )}
    </span>
  );
}

export function Pager<Row>({
  def,
  state,
  shown,
  total,
  nextCursor,
}: {
  def: ObjectDef<Row>;
  state: ViewState;
  shown: number;
  total: number | null;
  nextCursor: string | null;
}) {
  if (def.paging === 'offset') {
    const prevHref = prevOffsetHref(def, state);
    const nextHref = nextOffsetHref(def, state, shown, total);
    return (
      <nav className={s.pager} aria-label="Pagination">
        <span className={s.range}>{pageRange(state, shown, total)}</span>
        <PageSizes def={def} state={state} />
        <span className={s.pagerLinks}>
          {state.offset > 0 ? <Link href={viewHref(def, state, { offset: 0 })}>First page</Link> : null}
          {prevHref ? (
            <Link href={prevHref} rel="prev">
              ← Previous
            </Link>
          ) : null}
          {nextHref ? (
            <Link href={nextHref} rel="next">
              Next →
            </Link>
          ) : null}
        </span>
      </nav>
    );
  }
  const prev = prevPageHref(def, state);
  const trailCut = state.after !== null && state.prev.length === 0;
  const first = viewHref(def, state, { after: null, prev: [] });
  return (
    <nav className={s.pager} aria-label="Pagination">
      <span className={s.range}>
        {pageRange(state, shown, total)}
        {total === null && nextCursor ? ' · more' : ''}
      </span>
      <PageSizes def={def} state={state} />
      <span className={s.pagerLinks}>
        {state.after ? (
          first === prev && !trailCut ? (
            // Page 2: First page and Previous are the same link.
            <span aria-disabled="true" className="muted">
              First page
            </span>
          ) : (
            <Link href={first}>First page</Link>
          )
        ) : null}
        {prev && !trailCut ? (
          <Link href={prev} rel="prev">
            ← Previous
          </Link>
        ) : null}
        {nextCursor ? (
          <Link href={nextPageHref(def, state, nextCursor)} rel="next">
            Next →
          </Link>
        ) : null}
      </span>
    </nav>
  );
}
