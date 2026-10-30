import type { FieldClass } from '../contracts/sections';
import { type AssertionState, transitionGuard } from './transitions';

/**
 * Revival of a superseded assertion (automation `SUPERSEDED → PROPOSED`, domain doc §5/§6).
 * Pure: no I/O.
 *
 * A `current_state` value legitimately comes back (London → Berlin → London): the third
 * source supports the same value, hence the same assertion (`det(itemId, valueKey)`), which is
 * `SUPERSEDED`. It may return to `PROPOSED` only when:
 *  (a) the item's field class is `current_state`, the assertion was not superseded by an item
 *      merge (causes `newer_state`, `confirmed_rival`, `subject`, `subject_decision`), and its
 *      item is still active;
 *  (b) the new support is **strictly later** in source chronology than the threshold captured
 *      when it was superseded (`supersededAtAsOf`: the winner's `sourceAsOf` for automation,
 *      the recorded `validTo` for the subject) — so replaying or reprocessing an older
 *      snapshot never revives anything;
 *  (b*) exception to (b): a stored **automation** supersession (cause `newer_state` or
 *      `confirmed_rival`) is re-evaluated on every recompute; when it no longer holds — the
 *      superseder was rejected, or no longer has the chronology that won (its current newest
 *      support, or its confirmation time when `CONFIRMED`, is earlier than the stored
 *      `supersededAtAsOf`; a winner without any support left has none) — the value is a revival
 *      candidate regardless of dates (`supersessionInvalid`). Never after a subject supersession,
 *      never for merges, never for historical or set-member values (checked before this
 *      exception);
 *  (b') after a **subject** supersession (`mark_outdated`, another value confirmed) or a
 *      `subject_decision` hold, only a **declared** document date counts: an undated document's
 *      `sourceAsOf` is its acquisition time, which says nothing about when the value was true,
 *      so it never undoes what the subject said (refusal `undeclared_date`). The reconciler
 *      asks instead (`confirm_new` / `outdated_restated`) when subject-authored support is newer
 *      than the decision.
 * Dates are `observation.sourceAsOf` values (immutable per observation), never a snapshot's
 * `sourceAsOf`, which moves forward on genuine re-acquisition.
 *
 * What happens next is reconciliation's job (`reconciliation/policy.ts`): a revived value under
 * a confirmed rival becomes `CONFLICTED` with a `reconfirm` request and the canonical value is
 * unchanged; every revival is a recorded transition with an event keeping the prior
 * supersession (`supersededBy`, cause, `supersededAtAsOf`) and a new profile version.
 */

/**
 * Why an assertion was superseded (its `stateReason` class):
 * `newer_state` (chronology), `confirmed_rival` (older than a confirmed value), `subject`
 * (mark_outdated, rival confirmed), `subject_decision` (agrees with a value the subject rejected or
 * marked outdated; held while that decision stands), `merge`.
 */
export const SUPERSESSION_CAUSES = [
  'newer_state',
  'confirmed_rival',
  'subject',
  'subject_decision',
  'merge',
] as const;
export type SupersessionCause = (typeof SUPERSESSION_CAUSES)[number];

export interface RevivalInput {
  state: AssertionState;
  fieldClass: FieldClass;
  /** Why it was superseded. (The stored `supersededBy` field is the winner's assertion id.) */
  supersessionCause: SupersessionCause;
  itemActive: boolean;
  /**
   * The chronology threshold captured **at supersession time** and stored on the assertion:
   * the winner's `sourceAsOf` (automation) or the recorded `validTo` (subject). Stored rather
   * than looked up, so a later-withdrawn winner never makes revival impossible (or easier).
   */
  supersededAtAsOf?: Date;
  /** Newest `observation.sourceAsOf` among the assertion's current support. */
  newSupportAsOf: Date;
  /** Newest `observation.sourceAsOf` among current support whose date is a declared document date. */
  newDeclaredSupportAsOf?: Date;
  /**
   * The stored supersession no longer holds (computed by the reconciler every recompute): the
   * superseder is gone or rejected, or no longer has the chronology it won with.
   */
  supersessionInvalid?: boolean;
}

export const REVIVAL_REFUSALS = [
  'not_superseded',
  'not_current_state',
  'merged',
  'item_inactive',
  'no_chronology',
  'not_newer',
  'undeclared_date',
] as const;
export type RevivalRefusal = (typeof REVIVAL_REFUSALS)[number];

export type RevivalDecision = { revive: true } | { revive: false; reason: RevivalRefusal };

export function canRevive(i: RevivalInput): RevivalDecision {
  if (i.state !== 'SUPERSEDED') return { revive: false, reason: 'not_superseded' };
  if (i.fieldClass !== 'current_state') return { revive: false, reason: 'not_current_state' };
  if (i.supersessionCause === 'merge') return { revive: false, reason: 'merged' };
  if (!i.itemActive) return { revive: false, reason: 'item_inactive' };
  // (b*) an automation supersession whose basis no longer exists.
  const automation = i.supersessionCause === 'newer_state' || i.supersessionCause === 'confirmed_rival';
  if (automation && i.supersessionInvalid) return { revive: true };
  // A value held by a subject decision comes back when that decision no longer stands.
  if (i.supersessionCause === 'subject_decision' && i.supersessionInvalid) return { revive: true };
  const threshold = i.supersededAtAsOf;
  if (!threshold) return { revive: false, reason: 'no_chronology' };
  const after = (d: Date | undefined) => d !== undefined && d.getTime() > threshold.getTime();
  if (i.supersessionCause === 'subject' || i.supersessionCause === 'subject_decision') {
    if (after(i.newDeclaredSupportAsOf)) return { revive: true };
    return { revive: false, reason: after(i.newSupportAsOf) ? 'undeclared_date' : 'not_newer' };
  }
  if (!after(i.newSupportAsOf)) return { revive: false, reason: 'not_newer' };
  return { revive: true };
}

export type RevivalWriteGuard = ReturnType<typeof transitionGuard>;
export type RevivalGuardDecision =
  { revive: true; guard: RevivalWriteGuard } | { revive: false; reason: RevivalRefusal };

/**
 * The automation write filter for a revival (`SUPERSEDED → PROPOSED`), issued **only** when
 * `canRevive` allows it. Revival writes must obtain their guard here, never from
 * `transitionGuard` directly, so the conditions the transition table cannot express are
 * checked on every revival.
 */
export function revivalGuard(i: RevivalInput): RevivalGuardDecision {
  const d = canRevive(i);
  if (!d.revive) return d;
  return { revive: true, guard: transitionGuard('SUPERSEDED', 'PROPOSED', 'automation') };
}
