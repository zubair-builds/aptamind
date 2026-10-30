import { z } from 'zod';
import type { RegisterRow } from './adapter';

/**
 * History registers replace a period's rows per source (DECISION_LOG "Sponsor register adapters"
 * (3)): the latest complete import of a fiscal year replaces the source's earlier rows for that
 * year. Replacement is destructive, so each period has its own shrink guard: a file whose
 * evidence rows for a period fall below half of that period's last complete import is held back
 * (its rows of that period are not processed and its marker does not move), unless an operator
 * confirmed exactly that shrink (the history `source_anomaly` review, `confirm`).
 *
 * The parse step is the ONE place that decides (delta review B-M1): it plans the periods against
 * the markers it read, and finalisation applies exactly that plan with a compare-and-set on each
 * marker it was based on. There is one ratio, {@link HISTORY_MIN_ROW_RATIO}.
 */

export const HISTORY_MIN_ROW_RATIO = 0.5;

export interface HistoryPeriodMarker {
  period: number;
  completeAt: Date;
  rowCount: number;
  snapshotId: string;
  /** Parser (`name/version`) that read the marker's file (delta review L3). */
  parser?: string;
}

/** The marker a plan was based on (what finalisation compares-and-sets against). */
export interface HistoryMarkerRef {
  snapshotId: string;
  /** ISO time. */
  completeAt: string;
  rowCount: number;
  parser: string | null;
}

export interface HistoryPeriodPlan {
  period: number;
  rows: number;
  /** Held back by the shrink guard: not processed, marker not moved. */
  heldBack: boolean;
  previousRows: number | null;
  /** An operator confirmed this exact shrink (same baseline, same row count). */
  confirmed: boolean;
  marker: HistoryMarkerRef | null;
}

/** Evidence rows per period (fiscal year) of a parsed history file. */
export function periodCounts(rows: readonly RegisterRow[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const r of rows) {
    const fy = r.history?.fiscalYear;
    if (fy !== undefined) counts.set(fy, (counts.get(fy) ?? 0) + 1);
  }
  return counts;
}

/**
 * The review key of a held-back period: one per (source, period, snapshot, baseline marker), so a
 * confirmation belongs to exactly the shrink it was given for.
 */
export function historyShrinkReviewKey(
  sourceId: string,
  period: number,
  snapshotId: string,
  marker: Pick<HistoryMarkerRef, 'snapshotId' | 'completeAt'>,
): string {
  return `source_anomaly:${sourceId}:history_shrink:FY${period}:${snapshotId}:${marker.snapshotId}@${marker.completeAt}`;
}

export function planHistoryPeriods(
  rows: readonly RegisterRow[],
  previous: readonly HistoryPeriodMarker[] | undefined,
  snapshotId: string,
  parser: string,
  /** Row counts an operator confirmed, by period (for this snapshot and baseline). */
  confirmedRows: ReadonlyMap<number, number> = new Map(),
): HistoryPeriodPlan[] {
  return [...periodCounts(rows).entries()]
    .sort(([a], [b]) => a - b)
    .map(([period, n]) => {
      const prev = previous?.find((p) => p.period === period);
      // Re-processing the marker's own snapshot with the same parser never trips the guard; a
      // new parser version re-reads it and is guarded like a new file (delta review L3).
      const sameRead = !!prev && prev.snapshotId === snapshotId && (prev.parser ?? null) === parser;
      const shrank = !!prev && !sameRead && n < prev.rowCount * HISTORY_MIN_ROW_RATIO;
      const confirmed = shrank && confirmedRows.get(period) === n;
      return {
        period,
        rows: n,
        heldBack: shrank && !confirmed,
        previousRows: prev?.rowCount ?? null,
        confirmed,
        marker: prev
          ? {
              snapshotId: prev.snapshotId,
              completeAt: prev.completeAt.toISOString(),
              rowCount: prev.rowCount,
              parser: prev.parser ?? null,
            }
          : null,
      };
    });
}

/** `name/version` of an adapter's parser, as stored on a period marker. */
export function parserTag(parser: { name: string; version: string }): string {
  return `${parser.name}/${parser.version}`;
}

/** A period decision of the parse step, applied as is by finalisation (delta review B-M1). */
export const historyPeriodPlanSchema = z.object({
  period: z.number().int(),
  rows: z.number().int(),
  heldBack: z.boolean(),
  previousRows: z.number().int().nullable(),
  confirmed: z.boolean(),
  marker: z
    .object({
      snapshotId: z.string(),
      completeAt: z.string(),
      rowCount: z.number().int(),
      parser: z.string().nullable(),
    })
    .nullable(),
});
