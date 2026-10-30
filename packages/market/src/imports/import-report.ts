import type { Collection } from 'mongodb';
import { z } from 'zod';
import type { ReviewItemDoc } from '../review/schemas';

/** Most ids of each kind an import trace lists (the contract's cap). */
export const TRACE_MAX_IDS = 200;

/** Row counts of one import run, as the contract names them (market-imports.md). */
export const importCountsSchema = z.object({
  rows: z.number().int(),
  parsed: z.number().int(),
  accepted: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  ignored: z.number().int(),
  failed: z.number().int(),
  reviews: z.number().int(),
  /** Row and file warnings (for example a domain refused as shared hosting); listed in the report. */
  warnings: z.number().int(),
});
export type ImportCounts = z.infer<typeof importCountsSchema>;

export const importTraceIdsSchema = z.object({
  reviewIds: z.array(z.string()),
  companyIds: z.array(z.string()),
  sourceIds: z.array(z.string()),
  truncated: z.boolean(),
});
export type ImportTraceIds = z.infer<typeof importTraceIdsSchema>;

/** What an import workflow's final node reports; `GET /api/imports/:id` reads it from the run output. */
export const importReportSchema = z.object({
  counts: importCountsSchema,
  trace: importTraceIdsSchema.extend({
    /** The import report artifact (every row error and warning), when the run wrote one. */
    reportArtifactId: z.string().nullable(),
  }),
});
export type ImportReport = z.infer<typeof importReportSchema>;

/** Collects distinct trace ids, at most `TRACE_MAX_IDS` per kind; `truncated` says some were left out. */
export class TraceCollector {
  private readonly sets = {
    reviewIds: new Set<string>(),
    companyIds: new Set<string>(),
    sourceIds: new Set<string>(),
  };
  private truncated = false;

  add(kind: keyof typeof this.sets, id: string | null | undefined): void {
    if (!id) return;
    const set = this.sets[kind];
    if (set.has(id)) return;
    if (set.size >= TRACE_MAX_IDS) this.truncated = true;
    else set.add(id);
  }

  result(): ImportTraceIds {
    return {
      reviewIds: [...this.sets.reviewIds],
      companyIds: [...this.sets.companyIds],
      sourceIds: [...this.sets.sourceIds],
      truncated: this.truncated,
    };
  }
}

/** Review ids are checked against the store in chunks of this size. */
const REVIEW_CHUNK = 1000;

/**
 * The ids among `ids` of reviews created at or after `since` (input order kept). A row or file
 * review raised again by a later import keeps its first `createdAt`, so it is not "opened" by it.
 */
export async function reviewsOpenedSince(
  reviews: Collection<ReviewItemDoc>,
  ids: Iterable<string>,
  since: Date,
): Promise<string[]> {
  const all = [...new Set(ids)];
  const opened = new Set<string>();
  for (let i = 0; i < all.length; i += REVIEW_CHUNK) {
    const docs = await reviews
      .find(
        { _id: { $in: all.slice(i, i + REVIEW_CHUNK) }, createdAt: { $gte: since } },
        { projection: { _id: 1 } },
      )
      .toArray();
    for (const d of docs) opened.add(d._id);
  }
  return all.filter((id) => opened.has(id));
}
