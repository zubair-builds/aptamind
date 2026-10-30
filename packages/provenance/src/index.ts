import { z } from 'zod';

/**
 * Provenance and confidence primitives shared by every intelligence domain.
 *
 * A canonical fact is never a bare value: it carries the evidence that supports it, a
 * confidence assessment, any conflicting evidence, and the policy that chose it.
 */

export const AUTHORITY_TIERS = [
  'official_registry', // e.g. UK Home Office sponsor register — authoritative for licence presence
  'official_ats', // the employer's own ATS job board
  'official_site', // the employer's own website / careers page
  'third_party', // job boards, aggregators, directories
  'operator', // human review decision
  'inferred', // derived by Aptamind logic without direct statement
] as const;
export type AuthorityTier = (typeof AUTHORITY_TIERS)[number];

/** Default ranking; field policies may override (authority is field-specific). */
export const DEFAULT_AUTHORITY_RANK: Record<AuthorityTier, number> = {
  operator: 100,
  official_registry: 90,
  official_ats: 80,
  official_site: 70,
  third_party: 40,
  inferred: 10,
};

export const evidenceReferenceSchema = z.object({
  sourceId: z.string(),
  observationId: z.string().optional(),
  snapshotId: z.string().optional(),
  artifactId: z.string().optional(),
  /** Field path, JSON pointer or text span locating the evidence inside the artifact/observation. */
  locator: z.string().optional(),
  /** Short verbatim excerpt (≤ 300 chars) so reviewers can see the evidence without opening the artifact. */
  quote: z.string().max(600).optional(),
  observedAt: z.coerce.date(),
  authority: z.enum(AUTHORITY_TIERS).optional(),
  extractor: z.object({ name: z.string(), version: z.string() }).optional(),
});
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'unknown'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const confidenceSchema = z.object({
  level: z.enum(CONFIDENCE_LEVELS),
  /** Optional; only set when there is a genuine basis for a number. */
  score: z.number().min(0).max(1).optional(),
  reasons: z.array(z.string()).default([]),
});
export type Confidence = z.infer<typeof confidenceSchema>;

export const UNKNOWN_CONFIDENCE: Confidence = { level: 'unknown', reasons: [] };

export function confidence(level: ConfidenceLevel, ...reasons: string[]): Confidence {
  return { level, reasons };
}

const CONF_RANK: Record<ConfidenceLevel, number> = { high: 3, medium: 2, low: 1, unknown: 0 };
export function compareConfidence(a: ConfidenceLevel, b: ConfidenceLevel): number {
  return CONF_RANK[a] - CONF_RANK[b];
}
export function minConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  return CONF_RANK[a] <= CONF_RANK[b] ? a : b;
}

export const FACT_STATUSES = ['known', 'unknown', 'conflicting'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export function factSchema<T extends z.ZodType>(value: T) {
  return z.object({
    value: value.nullable(),
    status: z.enum(FACT_STATUSES),
    confidence: confidenceSchema,
    evidence: z.array(evidenceReferenceSchema),
    conflicts: z
      .array(
        z.object({ value: value.nullable(), evidence: z.array(evidenceReferenceSchema), reason: z.string() }),
      )
      .default([]),
    policyVersion: z.string().optional(),
    updatedAt: z.coerce.date().optional(),
  });
}

export interface Fact<T> {
  value: T | null;
  status: FactStatus;
  confidence: Confidence;
  evidence: EvidenceReference[];
  conflicts: Array<{ value: T | null; evidence: EvidenceReference[]; reason: string }>;
  policyVersion?: string;
  updatedAt?: Date;
}

export function unknownFact<T>(reason = 'no evidence'): Fact<T> {
  return {
    value: null,
    status: 'unknown',
    confidence: { level: 'unknown', reasons: [reason] },
    evidence: [],
    conflicts: [],
  };
}

export function knownFact<T>(
  value: T,
  conf: Confidence,
  evidence: EvidenceReference[],
  policyVersion?: string,
): Fact<T> {
  return { value, status: 'known', confidence: conf, evidence, conflicts: [], policyVersion };
}

/** A candidate value for a field, as proposed by one observation. */
export interface FactCandidate<T> {
  value: T;
  evidence: EvidenceReference;
  authority: AuthorityTier;
  confidence: ConfidenceLevel;
  observedAt: Date;
}

export interface SelectPolicy<T> {
  policyVersion: string;
  /** Field-specific authority ranking (defaults to DEFAULT_AUTHORITY_RANK). */
  authorityRank?: Partial<Record<AuthorityTier, number>>;
  equals?: (a: T, b: T) => boolean;
  /**
   * When top candidates at the same authority disagree: `recency` picks the newest,
   * `conflict` marks the fact conflicting (value null) so it is reviewed.
   */
  sameAuthorityDisagreement?: 'recency' | 'conflict';
}

/**
 * Deterministic reconciliation for a single field: highest authority wins, then
 * confidence, then recency. Disagreeing candidates are retained as conflicts — evidence is
 * never discarded because another value won.
 */
export function selectFact<T>(candidates: FactCandidate<T>[], policy: SelectPolicy<T>): Fact<T> {
  if (candidates.length === 0) return { ...unknownFact<T>(), policyVersion: policy.policyVersion };
  const rank = { ...DEFAULT_AUTHORITY_RANK, ...(policy.authorityRank ?? {}) };
  const eq = policy.equals ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b));
  const sorted = [...candidates].sort(
    (a, b) =>
      (rank[b.authority] ?? 0) - (rank[a.authority] ?? 0) ||
      compareConfidence(b.confidence, a.confidence) ||
      b.observedAt.getTime() - a.observedAt.getTime(),
  );
  const top = sorted[0] as FactCandidate<T>;
  // Group candidates by value.
  const groups: Array<{ value: T; items: FactCandidate<T>[] }> = [];
  for (const c of sorted) {
    const g = groups.find((x) => eq(x.value, c.value));
    if (g) g.items.push(c);
    else groups.push({ value: c.value, items: [c] });
  }
  const winner = groups.find((g) => g.items.includes(top)) as { value: T; items: FactCandidate<T>[] };
  const others = groups.filter((g) => g !== winner);
  const sameTierRival = others.find((g) =>
    g.items.some((i) => (rank[i.authority] ?? 0) === (rank[top.authority] ?? 0)),
  );
  const conflicts = others.map((g) => ({
    value: g.value,
    evidence: g.items.map((i) => i.evidence),
    reason:
      (rank[g.items[0]!.authority] ?? 0) < (rank[top.authority] ?? 0)
        ? 'lower authority'
        : 'same authority disagreement',
  }));
  if (sameTierRival && (policy.sameAuthorityDisagreement ?? 'recency') === 'conflict') {
    return {
      value: null,
      status: 'conflicting',
      confidence: { level: 'low', reasons: ['sources of equal authority disagree'] },
      evidence: winner.items.map((i) => i.evidence),
      conflicts,
      policyVersion: policy.policyVersion,
    };
  }
  const reasons = [`${top.authority} source`];
  if (winner.items.length > 1) reasons.push(`${winner.items.length} observations agree`);
  if (sameTierRival) reasons.push('newer of disagreeing equal-authority sources');
  let level = top.confidence;
  if (sameTierRival && level === 'high') level = 'medium';
  return {
    value: winner.value,
    status: 'known',
    confidence: { level, reasons },
    evidence: winner.items.map((i) => i.evidence),
    conflicts,
    policyVersion: policy.policyVersion,
  };
}
