import { DAY_MS } from '@aptamind/contracts';

/**
 * Market raw-artifact retention (DECISION_LOG 2026-10-01 O "Artifact retention", OPS-3).
 * Canonical facts live in Mongo; raw snapshots are kept selectively. Each snapshot carries a
 * `retentionClass` and an `expiresAt`; a fetch of the same bytes extends `expiresAt`. Expiry is
 * application-controlled (a sweep that checks references first), never a bucket lifecycle rule,
 * because artifact keys are content addresses shared by every snapshot with the same bytes.
 */
export const RETENTION_CLASSES = [
  'web_snapshot',
  'register_snapshot',
  'import_file',
  'review_evidence',
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export const RETENTION_POLICY_VERSION = 'retention/1';

export const RETENTION_TTL_MS: Record<RetentionClass, number> = {
  /** Changed web/API snapshot (ATS listings, careers pages): ~30 d. */
  web_snapshot: 30 * DAY_MS,
  /** Government/register snapshots: ~365 d. */
  register_snapshot: 365 * DAY_MS,
  /** Operator/user import files: ~90 d after processing. */
  import_file: 90 * DAY_MS,
  /** Review/dispute evidence: at least 180 d (a hold extends to this). */
  review_evidence: 180 * DAY_MS,
};

export interface RetentionSourceHints {
  via: 'http' | 'browser' | 'upload' | 'crawl';
  category?: string;
  authorityTier?: string;
}

/** Deterministic class for a new snapshot from how it was acquired and what the source is. */
export function retentionClassFor(h: RetentionSourceHints): RetentionClass {
  if (h.authorityTier === 'official_registry') return 'register_snapshot';
  if (h.via === 'upload' || h.category === 'manual_import') return 'import_file';
  return 'web_snapshot';
}

export function expiresAtFor(cls: RetentionClass, from: Date): Date {
  return new Date(from.getTime() + RETENTION_TTL_MS[cls]);
}
