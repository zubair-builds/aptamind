import type { Db } from 'mongodb';
import { ConflictError } from '@aptamind/contracts';
import { companiesCollection } from './companies/company.schema';
import { jobsCollection } from './jobs/job.schema';

/** Longest merge chain followed to a survivor (records merged into records merged later). */
export const MERGE_CHAIN_MAX = 10;

/**
 * A merged record whose `mergedInto` chain does not end at an active record within
 * `MERGE_CHAIN_MAX` hops, loops, or breaks (merged without `mergedInto`, or a missing link). A 409:
 * the API never presents a merged record as a survivor.
 */
export class MergeChainError extends ConflictError {
  constructor(kind: 'company' | 'job', id: string, chain: string[], reason: 'cycle' | 'too_long' | 'broken') {
    super(`The merge chain of ${kind} ${id} does not end at an active ${kind} (${reason})`, {
      kind,
      id,
      chain,
      reason,
    });
    this.name = 'MergeChainError';
  }
}

/** Follow `mergedInto` from `first` to the active survivor, or throw `MergeChainError`. */
export async function followMergeChain<T extends { _id: string; status: string; mergedInto?: string }>(
  kind: 'company' | 'job',
  first: T,
  load: (id: string) => Promise<T | null>,
): Promise<T> {
  const chain: string[] = [];
  let cur: T | null = first;
  while (cur.status === 'merged') {
    chain.push(cur._id);
    const next = cur.mergedInto;
    if (!next) throw new MergeChainError(kind, first._id, chain, 'broken');
    if (chain.includes(next)) throw new MergeChainError(kind, first._id, [...chain, next], 'cycle');
    if (chain.length > MERGE_CHAIN_MAX) throw new MergeChainError(kind, first._id, chain, 'too_long');
    cur = await load(next);
    if (!cur) throw new MergeChainError(kind, first._id, [...chain, next], 'broken');
  }
  return cur;
}

/** Bound on the records collected as merged into a survivor (`mergedIdsInto`). */
export const MAX_MERGED_IDS = 200;

/**
 * The records merged into `id`, at any depth (a record merged into one that was merged later
 * included), breadth first through `by_merged_into`, at most `MERGE_CHAIN_MAX` levels and
 * `MAX_MERGED_IDS` records (`truncated` when more exist). Their history (verifications, labelled
 * runs) is the survivor's: a merge moves observations and copies, never these records (M6.2 MR1).
 */
export async function mergedIdsInto(
  db: Db,
  kind: 'company' | 'job',
  id: string,
): Promise<{ ids: string[]; truncated: boolean }> {
  const col = db.collection<{ _id: string; mergedInto?: string }>(
    kind === 'company' ? companiesCollection.name : jobsCollection.name,
  );
  const out = new Set<string>();
  let level = [id];
  let truncated = false;
  for (let depth = 0; level.length; depth++) {
    if (depth >= MERGE_CHAIN_MAX || out.size >= MAX_MERGED_IDS) {
      // At a bound: truncated only if the next level has a record not collected yet.
      truncated ||= !!(await col.findOne(
        { mergedInto: { $in: level, $exists: true }, _id: { $nin: [id, ...out] } },
        { projection: { _id: 1 } },
      ));
      break;
    }
    const found = (
      await col
        // `$exists` states the partial index's filter, so `by_merged_into` serves the `$in`.
        .find({ mergedInto: { $in: level, $exists: true } }, { projection: { _id: 1 } })
        .limit(MAX_MERGED_IDS - out.size + 1)
        .toArray()
    )
      .map((d) => String(d._id))
      .filter((m) => m !== id && !out.has(m));
    const next = found.slice(0, MAX_MERGED_IDS - out.size);
    for (const m of next) out.add(m);
    if (found.length > next.length) {
      truncated = true; // this level alone exceeds the bound
      break;
    }
    level = next;
  }
  return { ids: [...out], truncated };
}
