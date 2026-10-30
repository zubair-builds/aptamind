import { RANKED_TARGET_STATUSES, type TargetOrigin, type TargetStatus } from '../contracts/targets';

/**
 * Career target lifecycle (domain doc §9, R-25 … R-27). Pure: no I/O. Pinned row by row by
 * `transitions.test.ts` against every (from, to, actor) triple.
 *
 * Two actor classes, as for assertions (PL-3): the **subject** (an operator relaying what the
 * subject said — `operator_relayed` in v0.1) and **automation** (proposals from evidence, P5.2).
 * The subject's word outranks inference: automation may only create `proposed` targets and edit
 * its own proposals while they are proposed; it can never activate, pause, archive, accept,
 * decline or edit a target the subject stated or accepted.
 */
export const TARGET_ACTOR_CLASSES = ['subject', 'automation'] as const;
export type TargetActorClass = (typeof TARGET_ACTOR_CLASSES)[number];

/** `null` as the `from` status: the target is being created. */
export type TargetFrom = TargetStatus | null;

export interface TargetTransitionRule {
  from: TargetFrom;
  to: TargetStatus;
  actor: TargetActorClass;
  action: TargetAction;
}

export const TARGET_ACTIONS = [
  'create',
  'propose',
  'accept',
  'decline',
  'activate',
  'pause',
  'archive',
] as const;
export type TargetAction = (typeof TARGET_ACTIONS)[number];

export const TARGET_TRANSITIONS: readonly Readonly<TargetTransitionRule>[] = Object.freeze([
  // automation: proposals only
  { from: null, to: 'proposed', actor: 'automation', action: 'propose' },
  // subject
  { from: null, to: 'active', actor: 'subject', action: 'create' },
  { from: null, to: 'paused', actor: 'subject', action: 'create' },
  { from: 'proposed', to: 'active', actor: 'subject', action: 'accept' },
  { from: 'proposed', to: 'declined', actor: 'subject', action: 'decline' },
  { from: 'paused', to: 'active', actor: 'subject', action: 'activate' },
  { from: 'archived', to: 'active', actor: 'subject', action: 'activate' },
  { from: 'active', to: 'paused', actor: 'subject', action: 'pause' },
  { from: 'active', to: 'archived', actor: 'subject', action: 'archive' },
  { from: 'paused', to: 'archived', actor: 'subject', action: 'archive' },
]);

const key = (from: TargetFrom, to: TargetStatus, actor: TargetActorClass) => `${from ?? '-'}>${to}@${actor}`;
const ALLOWED = new Set(TARGET_TRANSITIONS.map((r) => key(r.from, r.to, r.actor)));

export function allowedTargetTransition(
  from: TargetFrom,
  to: TargetStatus,
  actor: TargetActorClass,
): boolean {
  return ALLOWED.has(key(from, to, actor));
}

/** The status an action leads to from `from`, or `null` when the action is not legal there. */
export function targetActionTarget(
  action: TargetAction,
  from: TargetFrom,
  actor: TargetActorClass,
): TargetStatus | null {
  const rule = TARGET_TRANSITIONS.find((r) => r.action === action && r.from === from && r.actor === actor);
  return rule?.to ?? null;
}

/** Whether a status carries a priority (`RANKED_TARGET_STATUSES`: active, paused). */
export function isRankedStatus(status: TargetStatus): boolean {
  return (RANKED_TARGET_STATUSES as readonly TargetStatus[]).includes(status);
}

/** What the spec-edit rule needs to know about a target. */
export interface TargetEditFacts {
  status: TargetStatus;
  origin: TargetOrigin;
  /** The subject has edited this proposal: it stays `proposed` but is subject-owned. */
  subjectEdited?: boolean;
  createdBy: { kind: string; id: string };
}

/**
 * Whether `actor` may edit the spec of a target (automation never overwrites the subject's input):
 * - the subject: while it is `proposed`, `active` or `paused`;
 * - automation: only a proposal it created itself (`createdBy` is this actor), while it is still
 *   `proposed` and the subject has not edited it.
 */
export function canEditTargetSpec(t: TargetEditFacts, actor: { kind: string; id: string }): boolean {
  const cls = targetActorClass(actor);
  if (cls === 'subject') return t.status === 'proposed' || t.status === 'active' || t.status === 'paused';
  return (
    t.status === 'proposed' &&
    t.origin === 'proposal' &&
    t.subjectEdited !== true &&
    t.createdBy.kind === actor.kind &&
    t.createdBy.id === actor.id
  );
}

/**
 * The actor class of an `Actor` (ADR-0008 seam). v0.1: the internal operator relays what the
 * subject said (attestation `operator_relayed`); system and workflow actors are automation.
 */
export function targetActorClass(actor: { kind: string; id?: string }): TargetActorClass {
  return actor.kind === 'internal-operator' ? 'subject' : 'automation';
}

/**
 * Basis of a target: what the subject stated or accepted is `confirmed`; a proposal (origin
 * `proposal`, until accepted — accepting sets origin `accepted_proposal`) is `inferred`.
 */
export function targetBasis(origin: TargetOrigin): 'confirmed' | 'inferred' {
  return origin === 'proposal' ? 'inferred' : 'confirmed';
}
