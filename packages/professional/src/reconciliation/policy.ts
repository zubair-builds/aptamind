import { canonicalJson } from '@aptamind/contracts';
import type { Confidence, FactStatus } from '@aptamind/provenance';
import type { Basis, ObservationMode } from '../contracts/basis';
import { CLAIM_TYPE_DEFS, type ClaimType } from '../contracts/claims';
import {
  type RevivalGuardDecision,
  type RevivalInput,
  revivalGuard,
  type RevivalWriteGuard,
  type SupersessionCause,
} from '../assertions/revival';
import { type AssertionState, transitionGuard } from '../assertions/transitions';
import {
  ALL_COMPATIBILITY_RULES,
  ATTRIBUTE_SPECS,
  type CompatibilityContext,
  type CompatibilityRule,
  compareValues,
  getAttribute,
  materialAttributes,
  mergeValues,
  type ValueComparison,
} from './compatibility';
import { canonicalConfidence } from './confidence';
import {
  type OpenRequestRef,
  type RequestRole,
  RECONCILER_REQUEST_TYPES,
  type RequestDraft,
  requestDraft,
  type RequestReason,
  type RequestType,
} from './requests';

/**
 * The item reconciliation policy (domain doc §6, PL-1 … PL-6, R-15). **Pure**: plain typed
 * values in, plain typed values out — no I/O, no clock, no randomness (enforced by
 * `purity.test.ts`). The revision-fenced reconciler (P3.2) reads an item and its assertions,
 * calls `reconcileItem`, and commits the result in one transaction; a recompute that yields
 * the same canonical value and no transitions or request changes commits nothing.
 *
 * Invariants (property-tested in `properties.test.ts`):
 * - automation never moves an assertion into or out of `CONFIRMED` / `REJECTED`: every
 *   transition is checked by `transitionGuard(from, to, 'automation')`, revivals by
 *   `revivalGuard` (never `transitionGuard` directly);
 * - a `CONFIRMED` value is the canonical value whatever other evidence exists (PL-1, PL-2):
 *   evidence against it becomes `CONFLICTED` + a `reconfirm` request;
 * - the result is a fixed point: reconciling the result again changes nothing.
 */
export const POLICY_VERSION = 'prof-rec-1';

/** PL-1 precedence, highest first: `confirmed > stated > extracted > inferred`. */
export const PRECEDENCE_LADDER: readonly Basis[] = Object.freeze([
  'confirmed',
  'stated',
  'extracted',
  'inferred',
]);

/**
 * A policy: version, precedence ladder, active compatibility rules and the revival guard. Only
 * `PROF_REC_1` is used in production; mutated policies exist in tests to prove that each rule
 * is load-bearing (reorder the ladder, drop a compatibility rule, drop a revival condition →
 * named golden cases fail).
 */
export interface ReconciliationPolicy {
  readonly version: string;
  readonly ladder: readonly Basis[];
  readonly compatibility: ReadonlySet<CompatibilityRule>;
  readonly revivalGuard: (i: RevivalInput) => RevivalGuardDecision;
}

export const PROF_REC_1: ReconciliationPolicy = Object.freeze({
  version: POLICY_VERSION,
  ladder: PRECEDENCE_LADDER,
  compatibility: ALL_COMPATIBILITY_RULES,
  revivalGuard,
});

// ---------------------------------------------------------------------------------------------
// Input.

/**
 * Summary of an assertion's **current** support (observations with `status: current` that
 * resolve to it; superseded and quarantined observations excluded). Dates are
 * `observation.sourceAsOf` values — immutable per observation, never a snapshot's moving
 * `sourceAsOf`.
 */
export interface SupportSummary {
  /** Current supporting observations. */
  count: number;
  /** Distinct modes among them. */
  modes: readonly ObservationMode[];
  /** Distinct source ids among them (counted as a union across assertions, B-M3). */
  sourceIds: readonly string[];
  /** Newest `sourceAsOf` among them (`null` iff `count = 0`). */
  latestAsOf: Date | null;
  /** Newest `sourceAsOf` among them whose date is a declared document date. */
  latestDeclaredAsOf?: Date | null;
  /** Newest `sourceAsOf` among them from a subject-authored source (`authorship: subject`). */
  latestSubjectAuthoredAsOf?: Date | null;
  /** How many of them carry an `unverified_span` warning. */
  unverifiedSpans?: number;
  /** Observations that supported it and are no longer current (superseded by a newer extractor, quarantined). */
  withdrawnSupport?: number;
}

/** How and when an assertion was superseded (stored with it at supersession time). */
export interface SupersessionRecord {
  cause: SupersessionCause;
  /** The winner's assertion id (automation, subject confirmation of a rival). */
  supersededBy?: string;
  /** Revival threshold: the winner's `sourceAsOf` (automation) or `validTo` (subject). */
  supersededAtAsOf?: Date;
}

interface AssertionSnapshotBase {
  assertionId: string;
  /** The claim type's normalized value. */
  value: unknown;
  support: SupportSummary;
  /** When the state last changed (for a `REJECTED` assertion: the rejection). */
  stateChangedAt?: Date;
  /** For `CONFIRMED`: the latest time the subject kept it ("keep" answer to a `reconfirm`). */
  reaffirmedAt?: Date;
  /** The assertion has confirmation history (for `REJECTED`: it was revoked, not rejected unconfirmed). */
  wasConfirmed?: boolean;
  /** For `REJECTED`: the latest time the subject said it is still wrong (`rejected_restated` answer). */
  rejectionReaffirmedAt?: Date;
  /** For `SUPERSEDED`: the stored supersession. */
  supersession?: SupersessionRecord;
}

/** A confirmed assertion always carries when it was confirmed (B-L2). */
export interface ConfirmedAssertionSnapshot extends AssertionSnapshotBase {
  state: 'CONFIRMED';
  /** When the subject confirmed it (attestation `statedAt`, else decision time). */
  confirmedAt: Date;
}

export interface UnconfirmedAssertionSnapshot extends AssertionSnapshotBase {
  state: Exclude<AssertionState, 'CONFIRMED'>;
  confirmedAt?: undefined;
}

export type AssertionSnapshot = ConfirmedAssertionSnapshot | UnconfirmedAssertionSnapshot;

export interface ItemSnapshot {
  itemId: string;
  claimType: ClaimType;
  /** `status: active` (merged items are reconciled by the merge decision, not here). */
  active: boolean;
  /** The canonical value as currently stored (for change detection and `confirm_change`). */
  canonical?: CanonicalDecision | null;
}

export interface ReconcileInput {
  item: ItemSnapshot;
  assertions: readonly AssertionSnapshot[];
  /** Open requests naming this item (reconciler-owned ones are kept or closed). */
  openRequests?: readonly OpenRequestRef[];
  /** Organization key groups recorded as aliases by resolution. */
  organizationAliases?: readonly (readonly string[])[];
}

// ---------------------------------------------------------------------------------------------
// Output.

export const CONFLICT_KINDS = [
  /** Evidence disagrees with the confirmed value (the confirmed value stays canonical). */
  'challenges_confirmed',
  /** Two confirmed assertions disagree (should not happen; surfaced, never auto-resolved). */
  'multiple_confirmed',
  /** Values of the winning basis tier disagree (historical; or current-state values of one date). */
  'same_basis',
  /** A lower-basis historical value disagrees with the winning tier. */
  'lower_basis',
  /** A newer current-state value of lower basis disagrees with the winner. */
  'lower_basis_newer',
  /**
   * A historical/set-member value agrees with a value the subject rejected or marked outdated, and
   * has no declared evidence newer than that decision: held out of the winner selection.
   */
  'contradicts_decision',
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export interface ConflictRecord {
  kind: ConflictKind;
  assertionIds: string[];
  /** Conflicting attribute names, sorted. */
  attributes: string[];
}

/** One attribute of the canonical record (composite values reconcile per attribute, §3.3). */
export interface AttributeFact {
  name: string;
  status: 'known' | 'conflicting';
  /** Present when the attribute is known and has a value. */
  value?: unknown;
}

export interface CanonicalDecision {
  /** `null` iff `status ∈ { unknown, conflicting }`. */
  value: unknown;
  status: FactStatus;
  basis: Basis | null;
  /**
   * The assertion whose value is exactly the canonical value, else the representative of the
   * winning tier (a merged value); `null` unless `status = known`.
   */
  assertionId: string | null;
  /** Assertions whose values support the canonical value (winner and compatible values). */
  supportingAssertionIds: string[];
  /** Compatible, more precise values not merged into the canonical value (suggestions only). */
  refinements: string[];
  conflicts: ConflictRecord[];
  attributes: AttributeFact[];
  confidence: Confidence;
  evidenceCount: number;
  policyVersion: string;
}

export const TRANSITION_REASONS = [
  'no_current_support',
  'support_returned',
  'revived',
  'rival_gone',
  'newer_state',
  'older_than_confirmed',
  'challenges_confirmed',
  'same_basis',
  'lower_basis',
  'lower_basis_newer',
  'subject_decision',
  'contradicts_decision',
] as const;
export type TransitionReason = (typeof TRANSITION_REASONS)[number];

/**
 * One guarded automation transition. P3.2 issues `{ _id: assertionId, ...guard } → { state: to }`
 * in order; consecutive steps of one assertion are a legal path (e.g. `WITHDRAWN → PROPOSED →
 * CONFLICTED`). Net no-op paths are dropped.
 */
export interface PolicyTransition {
  assertionId: string;
  from: AssertionState;
  to: AssertionState;
  reason: TransitionReason;
  guard: RevivalWriteGuard;
  /** Set when `to = SUPERSEDED`: what to store with the assertion. */
  supersession?: SupersessionRecord;
  /** Set on a revival: the supersession being undone (kept on the event, never erased). */
  prior?: SupersessionRecord;
}

export type EventType =
  | 'assertion.transitioned'
  | 'assertion.revived'
  | 'assertion.supersession_updated'
  | 'item.canonical_changed';

/**
 * A `SUPERSEDED` assertion that stays superseded but for a different reason (its supersession
 * was re-evaluated, e.g. the confirmed rival's chronology changed). P3.2 writes it with `guard`.
 */
export interface SupersessionUpdate {
  assertionId: string;
  guard: RevivalWriteGuard;
  supersession: SupersessionRecord;
  prior?: SupersessionRecord;
}

/** Event drafts (codes, states and ids only). P3.2 adds ids, actor, run and time. */
export interface EventDraft {
  entity: { kind: 'assertion' | 'item'; id: string };
  type: EventType;
  from?: AssertionState;
  to?: AssertionState;
  reason: string;
  supersession?: SupersessionRecord;
  prior?: SupersessionRecord;
}

export interface RequestChanges {
  /** Requests to open (not open yet). */
  open: RequestDraft[];
  /** Dedupe keys of open requests whose question still stands. */
  keep: string[];
  /** Open reconciler-owned requests whose question disappeared. */
  close: { dedupeKey: string; type: RequestType; reason: 'superseded' }[];
}

export interface ReconcileResult {
  policyVersion: string;
  itemId: string;
  skipped?: 'item_inactive';
  canonical: CanonicalDecision;
  /** Whether the canonical decision differs from `item.canonical` (see `canonicalFingerprint`): a new profile version. */
  changed: boolean;
  /**
   * Whether only derived fields (confidence, evidence count) differ from `item.canonical`: P3.2
   * writes the item (revision bump) without a new profile version (B-M2).
   */
  derivedChanged: boolean;
  transitions: PolicyTransition[];
  supersessionUpdates: SupersessionUpdate[];
  requests: RequestChanges;
  events: EventDraft[];
}

/**
 * What makes two canonical decisions "the same" for versioning: value, status, basis,
 * assertion, refinements, conflicts and per-attribute status. Confidence and evidence counts
 * are recomputed with it but do not by themselves make a change.
 */
export function canonicalFingerprint(c: CanonicalDecision | null | undefined): string {
  const x = c ?? unknownCanonical(POLICY_VERSION);
  return canonicalJson({
    value: x.value,
    status: x.status,
    basis: x.basis,
    assertionId: x.assertionId,
    refinements: [...x.refinements].sort(),
    conflicts: x.conflicts,
    attributes: x.attributes,
  });
}

export function unknownCanonical(policyVersion: string): CanonicalDecision {
  return {
    value: null,
    status: 'unknown',
    basis: null,
    assertionId: null,
    supportingAssertionIds: [],
    refinements: [],
    conflicts: [],
    attributes: [],
    confidence: { level: 'unknown', reasons: ['no_evidence'] },
    evidenceCount: 0,
    policyVersion,
  };
}

// ---------------------------------------------------------------------------------------------
// Implementation.

const ACTIVE: ReadonlySet<AssertionState> = new Set(['PROPOSED', 'CONFLICTED', 'CONFIRMED']);

interface Work {
  a: AssertionSnapshot;
  orig: AssertionState;
  state: AssertionState;
  steps: PolicyTransition[];
  basis: Basis | null;
  rank: number;
  asOf: number;
  /** How much the value says (leaf count; `present` counts as nothing) — representative choice. */
  precision: number;
  /** The comparable normalized value (`valueKey` material): the id-independent final tie-break. */
  key: string;
  /** The supersession as of now in this run (stored, or set by a transition to SUPERSEDED). */
  sup: SupersessionRecord | undefined;
}

/** Leaf count of a normalized value; an open end (`present`) carries no precision. */
function precisionOf(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + precisionOf(x), 0);
  if (v instanceof Date) return 1;
  if (typeof v === 'object') {
    const r = v as Record<string, unknown>;
    if (r.open === true) return 0;
    return Object.values(r).reduce((n: number, x) => n + precisionOf(x), 0);
  }
  return 1;
}

function rankOf(ladder: readonly Basis[], b: Basis | null): number {
  if (b === null) return 0;
  const i = ladder.indexOf(b);
  return i < 0 ? 0 : ladder.length - i;
}

/** `confirmed` iff `CONFIRMED` (§3.1, revival condition (c)); else the best mode by the ladder. */
function supportBasis(
  ladder: readonly Basis[],
  state: AssertionState,
  modes: readonly ObservationMode[],
): Basis | null {
  if (state === 'CONFIRMED') return 'confirmed';
  let best: Basis | null = null;
  for (const m of modes) if (rankOf(ladder, m) > rankOf(ladder, best)) best = m;
  return best;
}

const time = (d: Date | null | undefined): number => (d ? d.getTime() : Number.NEGATIVE_INFINITY);

function move(
  w: Work,
  to: AssertionState,
  reason: TransitionReason,
  extra: { guard?: RevivalWriteGuard; supersession?: SupersessionRecord; prior?: SupersessionRecord } = {},
): void {
  if (w.state === to) return;
  if (w.state === 'SUPERSEDED' && to === 'PROPOSED' && !extra.guard)
    throw new Error('revival transitions require a revivalGuard decision');
  // Throws `IllegalTransitionError` for anything automation may not do (e.g. touch CONFIRMED).
  const guard = extra.guard ?? transitionGuard(w.state, to, 'automation');
  const t: PolicyTransition = { assertionId: w.a.assertionId, from: w.state, to, reason, guard };
  if (extra.supersession) t.supersession = extra.supersession;
  if (extra.prior) t.prior = extra.prior;
  w.steps.push(t);
  w.state = to;
  w.sup = to === 'SUPERSEDED' ? extra.supersession : undefined;
}

/** Role assignment among active assertions: PROPOSED (agrees) or CONFLICTED (disagrees). */
function assign(w: Work, role: 'PROPOSED' | 'CONFLICTED', reason: TransitionReason): void {
  if (w.state === 'CONFIRMED') return;
  if (role === 'PROPOSED') move(w, 'PROPOSED', 'rival_gone');
  else move(w, 'CONFLICTED', reason);
}

/** Representative order: most precise, then newest, then by value — never by id or support count. */
function byRepresentative(x: Work, y: Work): number {
  return y.precision - x.precision || y.asOf - x.asOf || cmpKey(x, y);
}

/** Chronology order (current state): newest, then most precise, then by value. */
function byChronology(x: Work, y: Work): number {
  return y.asOf - x.asOf || y.precision - x.precision || cmpKey(x, y);
}

function cmpKey(x: Work, y: Work): number {
  return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
}

const ids = (ws: readonly Work[]) => ws.map((w) => w.a.assertionId).sort();

/**
 * When the subject decided against a value: its rejection (or the latest "still rejected"), or the
 * `validTo` it was marked outdated with (a "still outdated" answer moves `supersededAtAsOf`).
 */
function decisionTime(w: Work): number {
  if (w.state === 'REJECTED') return Math.max(time(w.a.stateChangedAt), time(w.a.rejectionReaffirmedAt));
  return time(w.sup?.supersededAtAsOf);
}

/**
 * The chronology a value stands on: its newest current support, and when CONFIRMED also its
 * confirmation and the latest "keep" (reaffirmation).
 */
function supersederChronology(s: Work): number {
  if (s.state === 'CONFIRMED') return Math.max(time(s.a.confirmedAt), time(s.a.reaffirmedAt), s.asOf);
  return s.asOf;
}

/**
 * Whether a stored supersession still holds (Ruling 1, re-evaluated every recompute):
 * - `newer_state`: the superseder exists, is not REJECTED, and still has the chronology that won
 *   (current newest support — or confirmation when CONFIRMED — not earlier than the stored threshold);
 * - `confirmed_rival`: the confirmed rival is still CONFIRMED with that chronology, or was superseded
 *   by the subject (values older than it never come back); REJECTED (revoked) → it no longer holds;
 * - `subject`: holds unless the value the subject preferred lost all its (former) evidence —
 *   which never revives anything (canRevive) but asks (`superseder_withdrawn`);
 * - `merge`: always holds.
 */
function supersessionHolds(prior: SupersessionRecord, s: Work | undefined): boolean {
  const threshold = time(prior.supersededAtAsOf);
  switch (prior.cause) {
    case 'merge':
      return true;
    case 'subject_decision':
      return (
        s !== undefined &&
        (s.state === 'REJECTED' || (s.state === 'SUPERSEDED' && s.sup?.cause === 'subject'))
      );
    case 'subject':
      // The preferred value lost the evidence it had — unless the subject has since kept it.
      return !(
        s &&
        s.a.support.count === 0 &&
        (s.a.support.withdrawnSupport ?? 0) > 0 &&
        !(time(s.a.reaffirmedAt) > time(s.a.confirmedAt))
      );
    case 'newer_state':
      return s !== undefined && s.state !== 'REJECTED' && supersederChronology(s) >= threshold;
    case 'confirmed_rival':
      if (!s || s.state === 'REJECTED') return false;
      if (s.state !== 'CONFIRMED') return true;
      return supersederChronology(s) >= threshold;
  }
}

export function reconcileItem(
  input: ReconcileInput,
  policy: ReconciliationPolicy = PROF_REC_1,
): ReconcileResult {
  const { item } = input;
  const claimType = item.claimType;
  const def = CLAIM_TYPE_DEFS[claimType];
  const ctx: CompatibilityContext = {
    rules: policy.compatibility,
    organizationAliases: input.organizationAliases ?? [],
  };
  const cmp = (x: Work, y: Work): ValueComparison =>
    compareValues(claimType, x.a.value, y.a.value, ctx, { a: x.asOf, b: y.asOf });
  const openRequests = input.openRequests ?? [];

  if (!item.active) {
    return {
      policyVersion: policy.version,
      itemId: item.itemId,
      skipped: 'item_inactive',
      canonical: item.canonical ?? unknownCanonical(policy.version),
      changed: false,
      derivedChanged: false,
      transitions: [],
      supersessionUpdates: [],
      requests: { open: [], keep: [], close: closeAll(openRequests) },
      events: [],
    };
  }

  for (const a of input.assertions)
    if (a.state === 'CONFIRMED' && !(a.confirmedAt instanceof Date))
      throw new Error(`confirmed assertion ${a.assertionId} has no confirmedAt`);
  const work: Work[] = [...input.assertions]
    .sort((x, y) => (x.assertionId < y.assertionId ? -1 : x.assertionId > y.assertionId ? 1 : 0))
    .map((a) => ({
      a,
      orig: a.state,
      state: a.state,
      steps: [],
      basis: null,
      rank: 0,
      asOf: time(a.support.latestAsOf),
      precision: precisionOf(a.value),
      key: canonicalJson(a.value),
      sup: a.state === 'SUPERSEDED' ? a.supersession : undefined,
    }));
  const byId = new Map(work.map((w) => [w.a.assertionId, w]));
  const derived: RequestDraft[] = [];
  const request = (
    type: RequestType,
    roles: Readonly<Record<string, RequestRole>>,
    reason: RequestReason,
    attributes?: string[],
  ) => {
    const assertionIds = Object.keys(roles).sort();
    derived.push(
      requestDraft(claimType, type, item.itemId, assertionIds, {
        reason,
        ...(attributes?.length ? { attributes } : {}),
        roles: assertionIds.map((assertionId) => ({ assertionId, role: roles[assertionId] as RequestRole })),
      }),
    );
  };
  const as = (ws: readonly Work[], role: RequestRole) =>
    Object.fromEntries(ws.map((w) => [w.a.assertionId, role])) as Record<string, RequestRole>;

  /** Values held out of the winner selection by a subject decision (Ruling 2), with that decision. */
  const held: [Work, Work][] = [];
  /** Whether decision `d` (rejected or marked outdated) holds the unconfirmed value `w` (Ruling 2). */
  const heldBy = (w: Work, d: Work): boolean => {
    const r = cmp(w, d);
    if (!r.compatible) return false;
    // A rejection only holds values at least as precise as the rejected one.
    if (d.state === 'REJECTED' && r.bMorePrecise) return false;
    // Newer declared evidence escapes the hold only for current-state values.
    if (def.fieldClass === 'current_state' && time(w.a.support.latestDeclaredAsOf) > decisionTime(d))
      return false;
    return true;
  };

  // 1. Support and revival — before the active set is computed.
  for (const w of work) {
    const s = w.a.support;
    if ((w.state === 'PROPOSED' || w.state === 'CONFLICTED') && s.count === 0)
      move(w, 'WITHDRAWN', 'no_current_support');
    else if (w.state === 'WITHDRAWN' && s.count > 0) move(w, 'PROPOSED', 'support_returned');
  }
  // Revival until nothing changes: whether a supersession holds depends on its superseder's state,
  // which may itself change by a revival in this run (independent of processing order).
  const revivalCandidates = work.filter(
    (w) => w.state === 'SUPERSEDED' && w.a.support.count > 0 && w.a.support.latestAsOf,
  );
  const evaluate = (w: Work) => {
    const s = w.a.support;
    const prior = w.a.supersession;
    const superseder = prior?.supersededBy ? byId.get(prior.supersededBy) : undefined;
    const supersessionInvalid = prior
      ? !supersessionHolds(prior, superseder) ||
        // A hold by a rejection covers only values at least as precise as the rejected one.
        (prior.cause === 'subject_decision' &&
          superseder?.state === 'REJECTED' &&
          cmp(w, superseder).bMorePrecise)
      : false;
    const decision = policy.revivalGuard({
      state: 'SUPERSEDED',
      fieldClass: def.fieldClass,
      // Without a stored supersession there is no chronology: `no_chronology`.
      supersessionCause: prior?.cause ?? 'newer_state',
      itemActive: item.active,
      supersededAtAsOf: prior?.supersededAtAsOf,
      newSupportAsOf: s.latestAsOf as Date,
      newDeclaredSupportAsOf: s.latestDeclaredAsOf ?? undefined,
      supersessionInvalid,
    });
    return { prior, superseder, supersessionInvalid, decision };
  };
  for (let changedInPass = true; changedInPass;) {
    changedInPass = false;
    for (const w of revivalCandidates) {
      if (w.state !== 'SUPERSEDED') continue;
      const { prior, decision } = evaluate(w);
      if (!decision.revive) continue;
      move(w, 'PROPOSED', 'revived', { guard: decision.guard, ...(prior ? { prior } : {}) });
      changedInPass = true;
    }
  }
  for (const w of revivalCandidates) {
    if (w.state !== 'SUPERSEDED') continue;
    const { prior, superseder, supersessionInvalid } = evaluate(w);
    // The subject superseded it with a value whose evidence is gone: never revive, ask instead.
    if (prior?.cause === 'subject' && superseder?.state === 'CONFIRMED' && supersessionInvalid)
      request(
        'reconfirm',
        { ...as([superseder], 'confirmed'), ...as([w], 'candidate') },
        'superseder_withdrawn',
      );
  }

  // 2. Basis of every assertion (by the ladder) and the active set.
  for (const w of work) {
    w.basis = supportBasis(policy.ladder, w.state, w.a.support.modes);
    w.rank = rankOf(policy.ladder, w.basis);
  }
  // Ruling 2: without a confirmed value, an unconfirmed value that agrees with a value the subject
  // rejected or marked outdated can never win: it would silently undo the decision under a
  // different valueKey. A rejection holds only values at least as precise as the rejected one
  // (rejecting "Python: expert" leaves plain "Python"; rejecting London, GB leaves GB); declared
  // evidence newer than the decision escapes the hold for current_state values only.
  const decidedAgainst = work.filter(
    (w) => w.state === 'REJECTED' || (w.state === 'SUPERSEDED' && w.sup?.cause === 'subject'),
  );
  if (decidedAgainst.length && !work.some((w) => w.state === 'CONFIRMED')) {
    for (const w of work) {
      if (w.state !== 'PROPOSED' && w.state !== 'CONFLICTED') continue;
      const r = decidedAgainst
        .filter((d) => heldBy(w, d))
        .sort((x, y) => decisionTime(y) - decisionTime(x) || cmpKey(x, y))[0];
      if (!r) continue;
      if (def.fieldClass === 'current_state')
        move(w, 'SUPERSEDED', 'subject_decision', {
          supersession: {
            cause: 'subject_decision',
            supersededBy: r.a.assertionId,
            supersededAtAsOf: new Date(decisionTime(r)),
          },
        });
      else {
        assign(w, 'CONFLICTED', 'contradicts_decision');
        held.push([w, r]);
      }
    }
  }
  const active = work.filter((w) => ACTIVE.has(w.state) && !held.some(([h]) => h === w));
  const topRank = Math.max(0, ...active.map((w) => w.rank));
  const top = active.filter((w) => w.rank === topRank);

  let canonical: CanonicalDecision = unknownCanonical(policy.version);
  const conflicts: ConflictRecord[] = held.map(([w, r]) => ({
    kind: 'contradicts_decision' as const,
    assertionIds: ids([w, r]),
    attributes: [],
  }));

  if (active.length > 0 && top.some((w) => w.basis === 'confirmed')) {
    // 3a. A confirmed value exists: it is canonical; evidence either corroborates or challenges it.
    const confirmed = top
      .filter((w) => w.basis === 'confirmed')
      .sort((x, y) => time(y.a.confirmedAt) - time(x.a.confirmedAt) || cmpKey(x, y));
    const C = confirmed[0] as Work;
    const cAsOf = supersederChronology(C);
    const supporting: Work[] = [C];
    const refinements: string[] = [];
    const challengers: Work[] = [];
    const challengeAttrs = new Set<string>();
    const multi: Work[] = [];
    const multiAttrs = new Set<string>();
    for (const w of active) {
      if (w === C) continue;
      const r = cmp(w, C);
      if (w.state === 'CONFIRMED') {
        if (r.compatible) supporting.push(w);
        else {
          multi.push(w);
          r.conflicting.forEach((x) => multiAttrs.add(x));
        }
        continue;
      }
      if (r.compatible) {
        assign(w, 'PROPOSED', 'rival_gone');
        supporting.push(w);
        if (r.aMorePrecise) refinements.push(w.a.assertionId);
      } else if (def.fieldClass === 'current_state' && !(w.asOf > cAsOf)) {
        // An older current-state value is history, not a challenge to what the subject confirmed.
        move(w, 'SUPERSEDED', 'older_than_confirmed', {
          supersession: {
            cause: 'confirmed_rival',
            supersededBy: C.a.assertionId,
            supersededAtAsOf: new Date(cAsOf),
          },
        });
      } else {
        assign(w, 'CONFLICTED', 'challenges_confirmed');
        challengers.push(w);
        r.conflicting.forEach((x) => challengeAttrs.add(x));
      }
    }
    if (challengers.length)
      conflicts.push({
        kind: 'challenges_confirmed',
        assertionIds: ids([C, ...challengers]),
        attributes: [...challengeAttrs].sort(),
      });
    if (multi.length)
      conflicts.push({
        kind: 'multiple_confirmed',
        assertionIds: ids([C, ...multi]),
        attributes: [...multiAttrs].sort(),
      });
    canonical = decided({
      value: C.a.value,
      status: 'known',
      basis: 'confirmed',
      assertionId: C.a.assertionId,
      supporting,
      refinements,
      conflicts,
      conflictingAttributes: new Set(),
      active,
    });
    // PL-2: a challenge to a confirmed value always asks the subject (materiality does not gate it).
    if (challengers.length || multi.length)
      request(
        'reconfirm',
        { ...as(challengers, 'challenger'), ...as(multi, 'confirmed'), ...as([C], 'confirmed') },
        challengers.length ? 'challenges_confirmed' : 'multiple_confirmed',
        [...new Set([...challengeAttrs, ...multiAttrs])].sort(),
      );
  } else if (active.length > 0 && def.fieldClass === 'current_state') {
    // 3b. Current state, pairwise within the winning tier, newest first: a value incompatible with
    // a newer kept value is superseded by it; same-date incompatible values are a same_basis
    // conflict; only pairwise-compatible values merge.
    const kept: Work[] = [];
    const tie = new Set<Work>();
    const tieAttrs = new Set<string>();
    for (const w of [...top].sort(byChronology)) {
      const rivals = kept.filter((k) => !cmp(w, k).compatible);
      const newer = rivals.find((k) => k.asOf > w.asOf);
      if (newer) {
        move(w, 'SUPERSEDED', 'newer_state', {
          supersession: {
            cause: 'newer_state',
            supersededBy: newer.a.assertionId,
            supersededAtAsOf: new Date(newer.asOf),
          },
        });
        continue;
      }
      for (const k of rivals) {
        tie.add(k);
        tie.add(w);
        cmp(w, k).conflicting.forEach((x) => tieAttrs.add(x));
      }
      kept.push(w);
    }
    const W = kept[0] as Work;
    const refinements: string[] = [];
    const lowerNewer: Work[] = [];
    const lowerRivals = new Set<Work>();
    const lowerAttrs = new Set<string>();
    const materialTie = materialAttributes(claimType, [...tieAttrs]).length > 0;
    const merged = mergeValues(
      claimType,
      [...kept].sort(byRepresentative).map((w) => w.a.value),
      ctx,
    );
    for (const w of active) {
      if (w.rank === topRank) continue;
      const rivals = kept.filter((k) => !cmp(w, k).compatible);
      const newest = rivals[0];
      if (!newest) {
        assign(w, 'PROPOSED', 'rival_gone');
        if (!materialTie && compareValues(claimType, w.a.value, merged, ctx).aMorePrecise)
          refinements.push(w.a.assertionId);
      } else if (w.asOf <= newest.asOf) {
        move(w, 'SUPERSEDED', 'newer_state', {
          supersession: {
            cause: 'newer_state',
            supersededBy: newest.a.assertionId,
            supersededAtAsOf: new Date(newest.asOf),
          },
        });
      } else {
        assign(w, 'CONFLICTED', 'lower_basis_newer');
        lowerNewer.push(w);
        rivals.forEach((k) => lowerRivals.add(k));
        rivals.forEach((k) => cmp(w, k).conflicting.forEach((x) => lowerAttrs.add(x)));
      }
    }
    for (const w of kept) assign(w, tie.has(w) ? 'CONFLICTED' : 'PROPOSED', 'same_basis');
    if (tie.size)
      conflicts.push({ kind: 'same_basis', assertionIds: ids([...tie]), attributes: [...tieAttrs].sort() });
    if (lowerNewer.length)
      conflicts.push({
        kind: 'lower_basis_newer',
        assertionIds: ids([...lowerRivals, ...lowerNewer]),
        attributes: [...lowerAttrs].sort(),
      });
    const rep = [...kept].sort(byRepresentative)[0] as Work;
    canonical = decided({
      value: materialTie ? null : merged,
      partial: merged,
      status: materialTie ? 'conflicting' : 'known',
      basis: W.basis,
      assertionId: rep.a.assertionId,
      supporting: materialTie ? kept.filter((w) => !tie.has(w)) : kept,
      refinements,
      conflicts,
      conflictingAttributes: tieAttrs,
      active,
    });
    deriveUnconfirmedRequests(W);
  } else if (active.length > 0) {
    // 3c. Historical facts and set members: chronology never decides; disagreement is a conflict.
    const tier = [...top].sort(byRepresentative);
    const involved = new Set<Work>();
    const sameAttrs = new Set<string>();
    for (let i = 0; i < tier.length; i++)
      for (let j = i + 1; j < tier.length; j++) {
        const r = cmp(tier[i] as Work, tier[j] as Work);
        if (!r.compatible) {
          involved.add(tier[i] as Work);
          involved.add(tier[j] as Work);
          r.conflicting.forEach((x) => sameAttrs.add(x));
        }
      }
    for (const w of tier) assign(w, involved.has(w) ? 'CONFLICTED' : 'PROPOSED', 'same_basis');
    const merged = mergeValues(
      claimType,
      tier.map((w) => w.a.value),
      ctx,
    );
    // Ruling 4: disagreement only on immaterial attributes keeps the item known (the attribute is
    // marked conflicting; the value comes from the representative).
    const known = materialAttributes(claimType, [...sameAttrs]).length === 0;
    const refinements: string[] = [];
    const lower: Work[] = [];
    const lowerAttrs = new Set<string>();
    for (const w of active) {
      if (w.rank === topRank) continue;
      const rs = tier.map((t) => cmp(w, t));
      const bad = rs.filter((r) => !r.compatible);
      if (bad.length) {
        assign(w, 'CONFLICTED', 'lower_basis');
        lower.push(w);
        bad.forEach((r) => r.conflicting.forEach((x) => lowerAttrs.add(x)));
      } else {
        assign(w, 'PROPOSED', 'rival_gone');
        if (known && compareValues(claimType, w.a.value, merged, ctx).aMorePrecise)
          refinements.push(w.a.assertionId);
      }
    }
    if (involved.size)
      conflicts.push({
        kind: 'same_basis',
        assertionIds: ids([...involved]),
        attributes: [...sameAttrs].sort(),
      });
    if (lower.length)
      conflicts.push({
        kind: 'lower_basis',
        assertionIds: ids([...tier.filter((t) => lower.some((l) => !cmp(l, t).compatible)), ...lower]),
        attributes: [...lowerAttrs].sort(),
      });
    canonical = decided({
      value: known ? merged : null,
      partial: merged,
      status: known ? 'known' : 'conflicting',
      basis: tier[0]?.basis ?? null,
      assertionId: (tier[0] as Work).a.assertionId,
      supporting: known ? tier : tier.filter((w) => !involved.has(w)),
      refinements,
      conflicts,
      conflictingAttributes: sameAttrs,
      active,
    });
    deriveUnconfirmedRequests(tier[0] as Work);
  }

  // Values the subject rejected or marked outdated, restated by a newer subject-authored source
  // (R-14; every field class): ask, never reopen.
  // A value held because it agrees with such a decision (Ruling 2) asks the same question.
  const reasonFor = (d: Work): RequestReason =>
    d.state === 'REJECTED' ? 'rejected_restated' : 'outdated_restated';
  for (const w of work) {
    const restated = time(w.a.support.latestSubjectAuthoredAsOf);
    if (w.state === 'REJECTED' || (w.state === 'SUPERSEDED' && w.sup?.cause === 'subject')) {
      if (restated > decisionTime(w))
        request('confirm_new', as([w], w.state === 'REJECTED' ? 'rejected' : 'outdated'), reasonFor(w));
      continue;
    }
    const decision =
      w.state === 'SUPERSEDED' && w.sup?.cause === 'subject_decision'
        ? byId.get(w.sup.supersededBy ?? '')
        : held.find(([h]) => h === w)?.[1];
    if (decision && restated > decisionTime(decision))
      request('confirm_new', as([w], 'candidate'), reasonFor(decision));
  }
  if (canonical.status === 'unknown' && conflicts.length) canonical = { ...canonical, conflicts };

  // Ruling 1(b): the subject said the value is outdated and nothing current remains — ask what is
  // current instead of resurrecting pre-confirmation history.
  // A revoked value (REJECTED with confirmation history) leaves the same question.
  if (canonical.status === 'unknown' && def.material) {
    const outdated = work
      .filter(
        (w) =>
          (w.state === 'SUPERSEDED' && w.sup?.cause === 'subject') ||
          (w.state === 'REJECTED' && w.a.wasConfirmed === true),
      )
      .sort((x, y) => decisionTime(y) - decisionTime(x) || cmpKey(x, y))[0];
    if (outdated) request('confirm_new', as([outdated], 'outdated'), 'current_unknown');
    // The item is unknown because a supported value is held by a subject decision: ask about it.
    const heldCandidate = work
      .filter(
        (w) =>
          w.a.support.count > 0 &&
          (held.some(([h]) => h === w) || (w.state === 'SUPERSEDED' && w.sup?.cause === 'subject_decision')),
      )
      .sort(byRepresentative)[0];
    if (heldCandidate) request('confirm_new', as([heldCandidate], 'candidate'), 'held_by_decision');
  }

  // Transitions: drop net no-op paths (e.g. revived, then superseded again by the same value). A
  // path back to SUPERSEDED with a different supersession record becomes a supersession update.
  const transitions: PolicyTransition[] = [];
  const supersessionUpdates: SupersessionUpdate[] = [];
  for (const w of work) {
    if (w.state !== w.orig) transitions.push(...w.steps);
    else if (w.state === 'SUPERSEDED' && w.steps.length) {
      const next = w.steps[w.steps.length - 1]?.supersession;
      if (next && canonicalJson(next) !== canonicalJson(w.a.supersession ?? null))
        supersessionUpdates.push({
          assertionId: w.a.assertionId,
          guard: { state: { $eq: 'SUPERSEDED', $nin: ['CONFIRMED', 'REJECTED'] } },
          supersession: next,
          ...(w.a.supersession ? { prior: w.a.supersession } : {}),
        });
    }
  }

  const prevFingerprint = canonicalFingerprint(item.canonical);
  const changed = canonicalFingerprint(canonical) !== prevFingerprint;
  const derivedChanged =
    !changed &&
    item.canonical != null &&
    canonicalJson({ c: canonical.confidence, n: canonical.evidenceCount }) !==
      canonicalJson({ c: item.canonical.confidence, n: item.canonical.evidenceCount });
  const events: EventDraft[] = transitions.map((t) => {
    const e: EventDraft = {
      entity: { kind: 'assertion', id: t.assertionId },
      type: t.reason === 'revived' ? 'assertion.revived' : 'assertion.transitioned',
      from: t.from,
      to: t.to,
      reason: t.reason,
    };
    if (t.supersession) e.supersession = t.supersession;
    if (t.prior) e.prior = t.prior;
    return e;
  });
  for (const u of supersessionUpdates) {
    const e: EventDraft = {
      entity: { kind: 'assertion', id: u.assertionId },
      type: 'assertion.supersession_updated',
      from: 'SUPERSEDED',
      to: 'SUPERSEDED',
      reason: 'supersession_reevaluated',
      supersession: u.supersession,
    };
    if (u.prior) e.prior = u.prior;
    events.push(e);
  }
  if (changed)
    events.push({
      entity: { kind: 'item', id: item.itemId },
      type: 'item.canonical_changed',
      reason: changeCause(transitions),
    });

  return {
    policyVersion: policy.version,
    itemId: item.itemId,
    canonical,
    changed,
    derivedChanged,
    transitions,
    supersessionUpdates,
    requests: requestChanges(derived, openRequests),
    events,
  };

  // --- helpers closing over the run ------------------------------------------------------------

  function decided(d: {
    value: unknown;
    partial?: unknown;
    status: FactStatus;
    basis: Basis | null;
    assertionId: string;
    supporting: readonly Work[];
    refinements: string[];
    conflicts: ConflictRecord[];
    conflictingAttributes: ReadonlySet<string>;
    active: readonly Work[];
  }): CanonicalDecision {
    const valueSource = d.value ?? d.partial ?? null;
    const exact =
      d.value === null
        ? undefined
        : d.supporting.find((w) => canonicalJson(w.a.value) === canonicalJson(d.value));
    const attributes: AttributeFact[] = ATTRIBUTE_SPECS[claimType].map((spec) => {
      if (d.conflictingAttributes.has(spec.name)) return { name: spec.name, status: 'conflicting' };
      const v = valueSource === null ? undefined : getAttribute(valueSource, spec);
      return v === undefined
        ? { name: spec.name, status: 'known' }
        : { name: spec.name, status: 'known', value: v };
    });
    const lowerBasisConflict = d.conflicts.some(
      (c) => c.kind === 'lower_basis' || c.kind === 'lower_basis_newer',
    );
    const challenged = d.conflicts.some(
      (c) => c.kind === 'challenges_confirmed' || c.kind === 'multiple_confirmed',
    );
    return {
      value: d.status === 'known' ? d.value : null,
      status: d.status,
      basis: d.status === 'unknown' ? null : d.basis,
      assertionId: d.status === 'known' ? (exact?.a.assertionId ?? d.assertionId) : null,
      supportingAssertionIds: ids(d.supporting),
      refinements: [...d.refinements].sort(),
      conflicts: d.conflicts,
      attributes: d.status === 'unknown' ? [] : attributes,
      confidence: canonicalConfidence({
        status: d.status,
        basis: d.basis,
        sources: new Set(d.supporting.flatMap((w) => w.a.support.sourceIds)).size,
        unverifiedSpans: d.supporting.reduce((n, w) => n + (w.a.support.unverifiedSpans ?? 0), 0),
        lowerBasisConflict,
        challenged,
      }),
      evidenceCount: work
        .filter((w) => ACTIVE.has(w.state) && !held.some(([h]) => h === w))
        .reduce((n, w) => n + w.a.support.count, 0),
      policyVersion: policy.version,
    };
  }

  /** Requests when no value is confirmed: resolve material conflicts, else confirm the value. */
  function deriveUnconfirmedRequests(winner: Work): void {
    if (!def.material) return;
    const conflictIds = new Set<string>();
    const attrs = new Set<string>();
    let sameBasis = false;
    for (const c of conflicts) {
      const material = materialAttributes(claimType, c.attributes);
      if (!material.length) continue;
      c.assertionIds.forEach((x) => conflictIds.add(x));
      material.forEach((x) => attrs.add(x));
      if (c.kind === 'same_basis') sameBasis = true;
    }
    if (conflictIds.size) {
      request(
        'resolve_conflict',
        Object.fromEntries([...conflictIds].map((x) => [x, 'rival' as const])),
        sameBasis ? 'same_basis_conflict' : 'lower_basis_conflict',
        [...attrs].sort(),
      );
      return;
    }
    if (canonical.status !== 'known') return;
    const W = winner.a.assertionId;
    if (def.fieldClass === 'current_state') {
      // A newer unconfirmed value replaced an older one: ask to confirm the change (new question
      // when the stored canonical value was another, now superseded, value; kept while it stands).
      const changes = new Set<string>();
      const prev = item.canonical;
      if (prev && prev.status === 'known' && prev.assertionId && prev.assertionId !== W) {
        if (byId.get(prev.assertionId)?.state === 'SUPERSEDED') changes.add(prev.assertionId);
      }
      for (const r of openRequests) {
        if (r.type !== 'confirm_change' || r.assertionIds.length !== 2 || !r.assertionIds.includes(W))
          continue;
        const other = r.assertionIds.find((x) => x !== W) as string;
        if (byId.get(other)?.state === 'SUPERSEDED') changes.add(other);
      }
      if (changes.size) {
        for (const other of changes) request('confirm_change', { [W]: 'to', [other]: 'from' }, 'newer_state');
        return;
      }
    }
    // A-L1: the question names the canonical assertion (the exact value shown, else the representative).
    request('confirm_new', { [canonical.assertionId ?? W]: 'candidate' }, 'unconfirmed_material');
  }
}

function changeCause(transitions: readonly PolicyTransition[]): string {
  const reasons = new Set(transitions.map((t) => t.reason));
  if (reasons.has('revived')) return 'revived';
  if (reasons.has('newer_state') || reasons.has('older_than_confirmed')) return 'newer_state';
  if (
    ['challenges_confirmed', 'same_basis', 'lower_basis', 'lower_basis_newer'].some((r) =>
      reasons.has(r as TransitionReason),
    )
  )
    return 'conflict';
  if (reasons.has('no_current_support')) return 'support_withdrawn';
  return 'recomputed';
}

function closeAll(open: readonly OpenRequestRef[]): RequestChanges['close'] {
  return open
    .filter((r) => RECONCILER_REQUEST_TYPES.includes(r.type))
    .map((r) => ({ dedupeKey: r.dedupeKey, type: r.type, reason: 'superseded' as const }))
    .sort((x, y) => (x.dedupeKey < y.dedupeKey ? -1 : 1));
}

function requestChanges(derived: readonly RequestDraft[], open: readonly OpenRequestRef[]): RequestChanges {
  const wanted = new Map<string, RequestDraft>();
  for (const r of derived) if (!wanted.has(r.dedupeKey)) wanted.set(r.dedupeKey, r);
  const openKeys = new Set(open.map((r) => r.dedupeKey));
  const sorted = [...wanted.values()].sort((x, y) => (x.dedupeKey < y.dedupeKey ? -1 : 1));
  return {
    open: sorted.filter((r) => !openKeys.has(r.dedupeKey)),
    keep: sorted.filter((r) => openKeys.has(r.dedupeKey)).map((r) => r.dedupeKey),
    close: closeAll(open.filter((r) => !wanted.has(r.dedupeKey))),
  };
}
