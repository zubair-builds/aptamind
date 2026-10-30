import type { Db } from 'mongodb';
import { getCollection } from '@aptamind/db';
import { INTERPRETATION_POLICY_VERSION } from '../enrichment/interpret';
import { jobsCollection } from './job.schema';

/**
 * Re-interpretation backfill (DECISION_LOG 8d96663 (3), 3dfe3c5 (4)): every job whose stored
 * employment `interpretation.policyVersion` is OLDER than the current one is re-reconciled through
 * `market.reconcile_job` — the code `market.job.reinterpret` runs — in the workflow
 * `market.jobs.reinterpret_outdated`, a named deploy step (reprocessing runbook, "Market
 * deploy"). Whatever the lifecycle state (CLOSED and POSSIBLY_STALE included) and whether or not
 * the job's sources are enabled; merged jobs are skipped (their survivor is the canonical job).
 * Operator overrides are applied by the reconciler as always, so they survive.
 *
 * Replay-safe and resumable: a re-interpreted job carries the current version and drops out of the
 * selection, so a re-run (or a retried chunk) does only what is left; `after` continues a keyset
 * page (`_id` order). Nothing is downgraded at read time: until a job is re-interpreted, its
 * stored interpretation (and version) is what readers see. Selection and counts use the
 * `by_policy_version` index ({policyVersion, status, _id}); no page scans the collection.
 */

/** `employment-policy/<yyyy-mm-dd>.<n>` → comparable parts; null when unparseable. */
function policyParts(v: string): [string, number] | null {
  const m = v.match(/^employment-policy\/(\d{4}-\d{2}-\d{2})\.(\d+)$/);
  return m ? [m[1]!, Number(m[2])] : null;
}

/**
 * Whether a stored policy version is older than `current`. A missing or unparseable version is
 * older (it predates versioned interpretations); a NEWER one (a rolled-back deploy) is not, so
 * the backfill never re-interprets newer output with older code.
 */
export function isOlderPolicyVersion(
  stored: string | null | undefined,
  current: string = INTERPRETATION_POLICY_VERSION,
): boolean {
  if (!stored) return true;
  if (stored === current) return false;
  const a = policyParts(stored);
  const b = policyParts(current);
  if (!a || !b) return true;
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/** The stored policy versions older than the current one (distinct over the index; tiny). */
async function outdatedVersions(db: Db, current: string): Promise<Array<string | null>> {
  const versions = (await getCollection(db, jobsCollection).distinct(
    'interpretation.policyVersion',
  )) as Array<string | null>;
  return versions.filter((v) => isOlderPolicyVersion(v, current));
}

export interface OutdatedInterpretationPage {
  policyVersion: string;
  /** Jobs to re-interpret, in `_id` order. */
  jobIds: string[];
  /** Merged jobs with an older version (skipped) and jobs with a newer version (skipped). */
  skippedMerged: number;
  skippedNewer: number;
  /** Continue after this id for the next page (null: nothing after this page). */
  nextAfter: string | null;
  /** Active jobs with an older version, from the start (before this page is re-interpreted). */
  outdatedTotal: number;
}

/** Active jobs whose interpretation is older than the current policy version (index-only count). */
export async function countOutdatedInterpretations(db: Db): Promise<number> {
  const older = await outdatedVersions(db, INTERPRETATION_POLICY_VERSION);
  if (!older.length) return 0;
  return getCollection(db, jobsCollection).countDocuments({
    'interpretation.policyVersion': { $in: older as string[] },
    status: 'active',
  });
}

/** One keyset page of active jobs whose interpretation is older than the current policy version. */
export async function selectOutdatedInterpretations(
  db: Db,
  opts: { after?: string; limit?: number } = {},
): Promise<OutdatedInterpretationPage> {
  const col = getCollection(db, jobsCollection);
  const current = INTERPRETATION_POLICY_VERSION;
  const limit = opts.limit ?? 1000;
  const older = await outdatedVersions(db, current);
  const allVersions = (await col.distinct('interpretation.policyVersion')) as Array<string | null>;
  const newer = allVersions.filter((v) => v !== current && !older.includes(v));
  const byVersion = { 'interpretation.policyVersion': { $in: older as string[] } };
  const [ids, outdatedTotal, skippedMerged, skippedNewer] = await Promise.all([
    older.length
      ? col
          .find(
            { ...byVersion, status: 'active', _id: { $gt: opts.after ?? '' } },
            { projection: { _id: 1 } },
          )
          .sort({ _id: 1 })
          .limit(limit + 1)
          .toArray()
      : Promise.resolve([]),
    older.length ? col.countDocuments({ ...byVersion, status: 'active' }) : Promise.resolve(0),
    older.length ? col.countDocuments({ ...byVersion, status: 'merged' }) : Promise.resolve(0),
    newer.length
      ? col.countDocuments({ 'interpretation.policyVersion': { $in: newer as string[] } })
      : Promise.resolve(0),
  ]);
  const page = ids.slice(0, limit).map((j) => j._id);
  return {
    policyVersion: current,
    jobIds: page,
    skippedMerged,
    skippedNewer,
    nextAfter: ids.length > limit ? page[page.length - 1]! : null,
    outdatedTotal,
  };
}
