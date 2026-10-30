import { OVERRIDDEN_BY_OPERATOR } from '../reconciliation/overrides';
import { z } from 'zod';
import { contentHash } from '@aptamind/contracts';
import { CONFIDENCE_LEVELS, FACT_STATUSES, type Fact } from '@aptamind/provenance';

/**
 * `view=summary` building blocks. A summary fact keeps what a list cell or a peek panel needs —
 * the value, its status, its confidence level (and score when there is one), the decision basis
 * and how many other values were retained — and drops evidence, the conflicting values and
 * policy metadata (fetch the full record for those).
 *
 * This is the cross-domain `SummaryFact` convention (`docs/programme/INTEGRATION_CONTRACTS.md`
 * § Summary convention): Professional read APIs use the same shape.
 */
export interface SummaryFact<T> {
  value: T | null;
  status: (typeof FACT_STATUSES)[number];
  confidence: { level: (typeof CONFIDENCE_LEVELS)[number]; score?: number };
  /** The primary reason of the decision (`confidence.reasons[0]`, ≤ `BASIS_MAX` chars); `null` when none. */
  basis: string | null;
  /** How many other (lower-ranked or disagreeing) values the fact retained (`conflicts.length`). */
  alternates: number;
}

/** Longest `basis` a summary carries (an operator override reason can be up to 2 000 chars). */
export const BASIS_MAX = 100;

/**
 * Size budget of one summary row (JSON characters). 3 KB since the cross-domain convention added
 * `basis`/`alternates` per fact and the version pins (`rev`, `contentHash`, versions); it was 2 KB.
 */
export const SUMMARY_ROW_MAX = 3072;

type SummarySource<T> = Pick<Fact<T>, 'value' | 'status'> & {
  confidence: { level: Fact<T>['confidence']['level']; score?: number; reasons?: string[] };
  conflicts?: Array<{ reason?: string }>;
};

export function summaryFact<T>(f: SummarySource<T> | undefined | null): SummaryFact<T> {
  if (!f)
    return { value: null, status: 'unknown', confidence: { level: 'unknown' }, basis: null, alternates: 0 };
  const reason = f.confidence.reasons?.[0];
  return {
    value: f.value ?? null,
    status: f.status,
    confidence:
      f.confidence.score === undefined
        ? { level: f.confidence.level }
        : { level: f.confidence.level, score: f.confidence.score },
    basis: reason ? (reason.length > BASIS_MAX ? `${reason.slice(0, BASIS_MAX - 1)}…` : reason) : null,
    // The value an operator override replaced is a "system reading", not an alternate (PR #21 M4).
    alternates: (f.conflicts ?? []).filter((c) => c.reason !== OVERRIDDEN_BY_OPERATOR).length,
  };
}

/**
 * Version pin of a record's summary facts: sha-256 over the canonical `{ path: { value, status,
 * confidence: { level, score } } }` of the facts at `paths`, read from the stored record (full
 * values, not the trimmed summary values). It changes whenever any of those facts changes value,
 * status or confidence — unlike the reconciliation `contentHash`, which drives the lifecycle
 * `CHANGED` state and ignores status and confidence. Missing facts hash as unknown.
 */
export function factsHash(doc: object, paths: readonly string[]): string {
  const facts: Record<string, unknown> = {};
  for (const path of paths) {
    let f: unknown = doc;
    for (const k of path.split('.'))
      f = f && typeof f === 'object' ? (f as Record<string, unknown>)[k] : undefined;
    const fact = f as SummarySource<unknown> | undefined | null;
    facts[path] = fact
      ? {
          value: fact.value ?? null,
          status: fact.status,
          confidence: { level: fact.confidence.level, score: fact.confidence.score },
        }
      : { value: null, status: 'unknown', confidence: { level: 'unknown' } };
  }
  return contentHash(facts);
}

/**
 * The Mongo projection of a fact for a summary: value, status, confidence, the reasons (for
 * `basis`) and one small field per conflict (for `alternates`) — no evidence, no conflicting values.
 */
export function factProjection(path: string): Record<string, 1> {
  return {
    [`${path}.value`]: 1,
    [`${path}.status`]: 1,
    [`${path}.confidence.level`]: 1,
    [`${path}.confidence.score`]: 1,
    [`${path}.confidence.reasons`]: 1,
    [`${path}.conflicts.reason`]: 1,
  };
}

/** DTO of a summary fact (strict: evidence must not leak into summaries). */
export function summaryFactDto<T extends z.ZodType>(value: T) {
  return z.strictObject({
    value: value.nullable(),
    status: z.enum(FACT_STATUSES),
    confidence: z.strictObject({ level: z.enum(CONFIDENCE_LEVELS), score: z.number().optional() }),
    basis: z.string().max(BASIS_MAX).nullable(),
    alternates: z.number().int().min(0),
  });
}
