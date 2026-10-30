import type { Collection, Document, Filter } from 'mongodb';
import type { SourceDoc } from '../sources/source.schema';
import { FRESHNESS_POLICIES } from './policies';

/**
 * Server-computed freshness of a source (M7.4). One definition serves the per-row state, the
 * list filter and the dashboard's overdue list:
 *
 *   disabled         the source is disabled (not expected to refresh)
 *   never_succeeded  enabled, and no run has ever succeeded
 *   overdue          enabled, and the last success is older than the source's `freshness.maxAgeMinutes`
 *   due              enabled, older than its policy class's refresh interval (`refreshEveryMs`)
 *                    but not yet overdue — only when the class is known and refreshes sooner
 *                    than the source's maximum age
 *   fresh            enabled and neither due nor overdue
 *
 * Age is `now - health.lastSuccessAt` (processing time of the last successful run). The
 * boundaries are strict: exactly `maxAge` old is not overdue.
 */
export const SOURCE_FRESHNESS_STATES = ['fresh', 'due', 'overdue', 'never_succeeded', 'disabled'] as const;
export type SourceFreshnessState = (typeof SOURCE_FRESHNESS_STATES)[number];

type FreshnessInput = Pick<SourceDoc, 'enabled' | 'freshness'> & {
  health: Pick<SourceDoc['health'], 'lastSuccessAt'>;
};

/** The refresh interval of a policy class, when the class is known. */
function refreshMs(policyClass: string): number | undefined {
  return FRESHNESS_POLICIES[policyClass]?.refreshEveryMs;
}

export function sourceFreshnessState(s: FreshnessInput, now: Date): SourceFreshnessState {
  if (!s.enabled) return 'disabled';
  const last = s.health.lastSuccessAt;
  if (!last) return 'never_succeeded';
  const age = now.getTime() - last.getTime();
  const maxAge = s.freshness.maxAgeMinutes * 60_000;
  if (age > maxAge) return 'overdue';
  const refresh = refreshMs(s.freshness.policyClass);
  if (refresh !== undefined && refresh < maxAge && age > refresh) return 'due';
  return 'fresh';
}

/** Age of the last success in ms, or `null` when the source never succeeded. */
export function sourceFreshnessAgeMs(s: FreshnessInput, now: Date): number | null {
  const last = s.health.lastSuccessAt;
  return last ? now.getTime() - last.getTime() : null;
}

/**
 * A Mongo filter for sources in any of `states` at `now` (`never_succeeded` excludes the built-in
 * `system:*` sources), served by the
 * `by_freshness` index (`enabled, freshness.policyClass, freshness.maxAgeMinutes,
 * health.lastSuccessAt`): the distinct (policy class, max age) pairs of enabled sources are read
 * from the index (covered), and each state becomes a bounded `lastSuccessAt` range per pair.
 */
export async function sourceFreshnessFilter(
  col: Collection<SourceDoc>,
  states: readonly SourceFreshnessState[],
  now: Date,
): Promise<Filter<Document>> {
  const branches: Document[] = [];
  if (states.includes('disabled')) branches.push({ enabled: false });
  // Built-in `system:*` sources are not scheduled (`system:operator` never runs): they would sit in
  // `never_succeeded` forever, so that filter leaves them out (their rows still report the state).
  if (states.includes('never_succeeded'))
    branches.push({ enabled: true, 'health.lastSuccessAt': null, key: { $not: /^system:/ } });
  const timed = states.filter((s) => s === 'fresh' || s === 'due' || s === 'overdue');
  if (timed.length) {
    const pairs = await col
      .aggregate<{ _id: { p: string; m: number } }>([
        { $match: { enabled: true } },
        { $group: { _id: { p: '$freshness.policyClass', m: '$freshness.maxAgeMinutes' } } },
      ])
      .toArray();
    const t = now.getTime();
    for (const { _id: pair } of pairs) {
      const maxAge = pair.m * 60_000;
      const refresh = refreshMs(pair.p);
      const hasDue = refresh !== undefined && refresh < maxAge;
      const base = { enabled: true, 'freshness.policyClass': pair.p, 'freshness.maxAgeMinutes': pair.m };
      if (timed.includes('overdue'))
        branches.push({ ...base, 'health.lastSuccessAt': { $lt: new Date(t - maxAge) } });
      if (timed.includes('due') && hasDue)
        branches.push({
          ...base,
          'health.lastSuccessAt': { $gte: new Date(t - maxAge), $lt: new Date(t - refresh) },
        });
      if (timed.includes('fresh'))
        branches.push({
          ...base,
          'health.lastSuccessAt': { $gte: new Date(t - (hasDue ? refresh : maxAge)) },
        });
    }
  }
  if (!branches.length) return { _id: { $exists: false } };
  return branches.length === 1 ? branches[0]! : { $or: branches };
}
