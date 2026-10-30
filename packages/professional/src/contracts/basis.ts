import type { AssertionState } from '../assertions/transitions';

/**
 * Basis and observation mode (domain doc §3.1, PL-1).
 *
 * - **Mode** of an observation: how the value entered the system — `stated` (subject-authored
 *   structured value), `extracted` (supported by a verbatim span of a source), `inferred`
 *   (derived without a verbatim statement).
 * - **Basis** of an assertion: `confirmed` iff its state is `CONFIRMED`, else the best mode of
 *   its current supporting observations.
 */

export const OBSERVATION_MODES = ['stated', 'extracted', 'inferred'] as const;
export type ObservationMode = (typeof OBSERVATION_MODES)[number];

export const BASES = ['confirmed', 'stated', 'extracted', 'inferred'] as const;
export type Basis = (typeof BASES)[number];

/** PL-1 precedence: `confirmed` (4) > `stated` (3) > `extracted` (2) > `inferred` (1). */
export const BASIS_RANK: Readonly<Record<Basis, number>> = Object.freeze({
  confirmed: 4,
  stated: 3,
  extracted: 2,
  inferred: 1,
});

/** Positive when `a` outranks `b`, zero when equal, negative otherwise. */
export function compareBasis(a: Basis, b: Basis): number {
  return BASIS_RANK[a] - BASIS_RANK[b];
}

/**
 * The basis of an assertion: `confirmed` **iff** its state is `CONFIRMED` — never because a
 * confirmation record is present (a revoked, superseded or rejected assertion keeps its
 * confirmation history but is not confirmed); otherwise the best mode among its current
 * supporting observations; `null` when it has no current support.
 */
export function basisOf(state: AssertionState, supportModes: readonly ObservationMode[]): Basis | null {
  if (state === 'CONFIRMED') return 'confirmed';
  let best: Basis | null = null;
  for (const m of supportModes) if (best === null || compareBasis(m, best) > 0) best = m;
  return best;
}
