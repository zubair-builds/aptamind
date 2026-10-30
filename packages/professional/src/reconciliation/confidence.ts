import { type Confidence, type ConfidenceLevel, minConfidence } from '@aptamind/provenance';
import type { Basis } from '../contracts/basis';

/**
 * Canonical confidence (domain doc §6): `f(basis, span verification, corroboration, conflicts)`
 * in the provenance `Confidence` shape. Reasons are enum-like strings, never quotes or values.
 */
export const CONFIDENCE_REASONS = [
  'confirmed',
  'stated',
  'extracted',
  'inferred',
  'unverified_span',
  'lower basis conflict',
  'challenged',
  'same basis conflict',
  'no_evidence',
] as const;
export type ConfidenceReason = (typeof CONFIDENCE_REASONS)[number] | `${number} sources agree`;

const BASE_LEVEL: Readonly<Record<Basis, ConfidenceLevel>> = Object.freeze({
  confirmed: 'high',
  stated: 'high',
  extracted: 'medium',
  inferred: 'low',
});

export interface ConfidenceInput {
  status: 'known' | 'unknown' | 'conflicting';
  basis: Basis | null;
  /** Distinct sources supporting the canonical value (all compatible supporting assertions). */
  sources: number;
  /** Supporting observations whose quote failed span verification. */
  unverifiedSpans: number;
  lowerBasisConflict: boolean;
  challenged: boolean;
}

export function canonicalConfidence(i: ConfidenceInput): Confidence {
  if (i.status === 'unknown' || i.basis === null) return { level: 'unknown', reasons: ['no_evidence'] };
  if (i.status === 'conflicting') return { level: 'low', reasons: ['same basis conflict'] };
  let level = BASE_LEVEL[i.basis];
  const reasons: ConfidenceReason[] = [i.basis];
  if (i.sources >= 2) {
    reasons.push(`${i.sources} sources agree`);
    if (level === 'medium') level = 'high';
  }
  if (i.unverifiedSpans > 0 && i.basis !== 'confirmed') {
    reasons.push('unverified_span');
    level = minConfidence(level, 'low');
  }
  if (i.lowerBasisConflict && i.basis !== 'confirmed') {
    reasons.push('lower basis conflict');
    level = minConfidence(level, 'medium');
  }
  if (i.challenged) reasons.push('challenged');
  return { level, reasons };
}
