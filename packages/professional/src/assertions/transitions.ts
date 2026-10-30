/**
 * The assertion lifecycle state machine (domain doc §5, PL-3). Pure: no I/O.
 *
 * Two actor classes exist. **Automation** (extraction, resolution, reconciliation, AI,
 * reprocessing, operator data-quality actions) and the **subject** (through a confirmation
 * operation carrying the subject's attestation — `operator_relayed` in v0.1). Only the subject
 * moves an assertion into or out of `CONFIRMED` / `REJECTED`.
 *
 * Every write is a guarded update `{ _id, state: from } → { state: to }` issued only after
 * `assertTransition(from, to, actor)`; automation writes additionally exclude the protected
 * states (`transitionGuard`). The table below is pinned row by row by `transitions.test.ts`
 * against every (from, to, actor) triple; flipping any row fails the suite.
 *
 * Two rows carry conditions the table cannot express:
 * - `SUPERSEDED → PROPOSED` (automation, revival) only as decided by `revival.ts`: its write
 *   filter comes from `revivalGuard` (which checks `canRevive`), never from `transitionGuard`;
 * - `null → CONFIRMED` (subject) only when no assertion with that value exists on the item —
 *   otherwise the decision is the existing assertion's own transition (`confirmationTransition`).
 */

export const ASSERTION_STATES = [
  'PROPOSED',
  'CONFIRMED',
  'REJECTED',
  'SUPERSEDED',
  'CONFLICTED',
  'WITHDRAWN',
] as const;
export type AssertionState = (typeof ASSERTION_STATES)[number];

export const ACTOR_CLASSES = ['automation', 'subject'] as const;
export type ActorClass = (typeof ACTOR_CLASSES)[number];

/** `null` as the `from` state: the assertion is being created. */
export type FromState = AssertionState | null;

/** States only the subject may enter or leave (PL-3). */
export const SUBJECT_ONLY_STATES: readonly AssertionState[] = Object.freeze(['CONFIRMED', 'REJECTED']);

export interface TransitionRule {
  from: FromState;
  to: AssertionState;
  actor: ActorClass;
  trigger: string;
}

/** Every allowed transition. Anything not listed is illegal. */
export const TRANSITIONS: readonly Readonly<TransitionRule>[] = Object.freeze([
  // automation
  { from: null, to: 'PROPOSED', actor: 'automation', trigger: 'first supporting observation' },
  { from: 'PROPOSED', to: 'CONFLICTED', actor: 'automation', trigger: 'incompatible rival found' },
  { from: 'CONFLICTED', to: 'PROPOSED', actor: 'automation', trigger: 'incompatible rival gone' },
  { from: 'PROPOSED', to: 'SUPERSEDED', actor: 'automation', trigger: 'newer current_state; merge' },
  { from: 'CONFLICTED', to: 'SUPERSEDED', actor: 'automation', trigger: 'newer current_state; merge' },
  { from: 'PROPOSED', to: 'WITHDRAWN', actor: 'automation', trigger: 'no current support left' },
  { from: 'CONFLICTED', to: 'WITHDRAWN', actor: 'automation', trigger: 'no current support left' },
  { from: 'WITHDRAWN', to: 'PROPOSED', actor: 'automation', trigger: 'support returns' },
  { from: 'WITHDRAWN', to: 'SUPERSEDED', actor: 'automation', trigger: 'item merged' },
  { from: 'SUPERSEDED', to: 'PROPOSED', actor: 'automation', trigger: 'newer current_state support' },
  // subject (confirmation operations)
  { from: null, to: 'CONFIRMED', actor: 'subject', trigger: 'confirm_with_edit (edited value)' },
  { from: 'PROPOSED', to: 'CONFIRMED', actor: 'subject', trigger: 'confirm' },
  { from: 'CONFLICTED', to: 'CONFIRMED', actor: 'subject', trigger: 'confirm' },
  { from: 'WITHDRAWN', to: 'CONFIRMED', actor: 'subject', trigger: 'confirm' },
  { from: 'PROPOSED', to: 'REJECTED', actor: 'subject', trigger: 'reject' },
  { from: 'CONFLICTED', to: 'REJECTED', actor: 'subject', trigger: 'reject' },
  { from: 'PROPOSED', to: 'SUPERSEDED', actor: 'subject', trigger: 'confirm_with_edit' },
  { from: 'CONFLICTED', to: 'SUPERSEDED', actor: 'subject', trigger: 'confirm_with_edit' },
  { from: 'CONFIRMED', to: 'SUPERSEDED', actor: 'subject', trigger: 'other value confirmed; mark_outdated' },
  { from: 'CONFIRMED', to: 'REJECTED', actor: 'subject', trigger: 'revoke' },
  { from: 'REJECTED', to: 'CONFIRMED', actor: 'subject', trigger: 'confirm (explicit un-reject)' },
  { from: 'SUPERSEDED', to: 'CONFIRMED', actor: 'subject', trigger: 'confirm (restore older value)' },
  { from: 'SUPERSEDED', to: 'REJECTED', actor: 'subject', trigger: 'reject (that old value was wrong)' },
]);

const ALLOWED = new Set(TRANSITIONS.map((r) => key(r.from, r.to, r.actor)));

function key(from: FromState, to: AssertionState, actor: ActorClass): string {
  return `${from ?? '-'}>${to}@${actor}`;
}

/** Whether `actor` may move an assertion from `from` (or create it, `null`) to `to`. */
export function allowedTransition(from: FromState, to: AssertionState, actor: ActorClass): boolean {
  return ALLOWED.has(key(from, to, actor));
}

export class IllegalTransitionError extends Error {
  readonly code = 'illegal_transition';
  constructor(
    readonly from: FromState,
    readonly to: AssertionState,
    readonly actor: ActorClass,
  ) {
    // Codes and enums only: never values (the runtime persists error messages).
    super(`illegal assertion transition ${from ?? '(new)'} -> ${to} by ${actor}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: FromState, to: AssertionState, actor: ActorClass): void {
  if (!allowedTransition(from, to, actor)) throw new IllegalTransitionError(from, to, actor);
}

/**
 * The state guard for a transition's write filter, after checking it is legal:
 * `{ state: from }`, and for automation additionally never a subject-only state — defence in
 * depth, so a mis-wired automation write can never match a confirmed or rejected assertion.
 * Creation (`from = null`) has no state guard (it is an insert).
 */
export function transitionGuard(
  from: AssertionState,
  to: AssertionState,
  actor: ActorClass,
): { state: AssertionState | { $eq: AssertionState; $nin: AssertionState[] } } {
  assertTransition(from, to, actor);
  if (actor === 'automation') return { state: { $eq: from, $nin: [...SUBJECT_ONLY_STATES] } };
  return { state: from };
}

/**
 * The subject transition a `confirm` / `confirm_with_edit` decision performs for a value whose
 * assertion may already exist (`assertionId = det(itemId, valueKey)`): creation (`null →
 * CONFIRMED`) only when no assertion with that value exists; otherwise the existing
 * assertion's own transition. Confirming an already confirmed value is no transition
 * (`reconfirmedAt` is recorded instead).
 */
export function confirmationTransition(
  existing: AssertionState | null,
): { from: FromState; to: 'CONFIRMED' } | { noop: true } {
  if (existing === 'CONFIRMED') return { noop: true };
  assertTransition(existing, 'CONFIRMED', 'subject');
  return { from: existing, to: 'CONFIRMED' };
}
