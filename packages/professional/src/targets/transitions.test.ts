import { describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR, UNAUTHENTICATED_INTERNAL_OPERATOR } from '@aptamind/contracts';
import { TARGET_ORIGINS, TARGET_STATUSES, type TargetStatus } from '../contracts/targets';
import {
  allowedTargetTransition,
  canEditTargetSpec,
  TARGET_ACTOR_CLASSES,
  TARGET_TRANSITIONS,
  type TargetActorClass,
  type TargetFrom,
  targetActionTarget,
  targetActorClass,
  targetBasis,
} from './transitions';

/**
 * The target lifecycle table, transcribed independently of the implementation (`— → X` is
 * written `new → X`). Every (from, to, actor) triple not listed must be denied.
 *
 *   — → proposed               automation  propose (P5.2)
 *   — → active | paused        subject     create (stated target)
 *   proposed → active          subject     accept
 *   proposed → declined        subject     decline
 *   paused | archived → active subject     activate (archived: restore)
 *   active → paused            subject     pause
 *   active | paused → archived subject     archive
 */
const SPEC = new Set([
  'new>proposed@automation',
  'new>active@subject',
  'new>paused@subject',
  'proposed>active@subject',
  'proposed>declined@subject',
  'paused>active@subject',
  'archived>active@subject',
  'active>paused@subject',
  'active>archived@subject',
  'paused>archived@subject',
]);

const FROM: TargetFrom[] = [null, ...TARGET_STATUSES];
const label = (from: TargetFrom, to: TargetStatus, actor: TargetActorClass) =>
  `${from ?? 'new'}>${to}@${actor}`;
const TRIPLES = FROM.flatMap((from) =>
  TARGET_STATUSES.flatMap((to) => TARGET_ACTOR_CLASSES.map((actor) => ({ from, to, actor }))),
);

describe('career target lifecycle — full (from, to, actor) table', () => {
  it('covers 6 from-states × 5 to-states × 2 actor classes', () => {
    expect(TRIPLES).toHaveLength(60);
    expect(TARGET_TRANSITIONS).toHaveLength(SPEC.size);
  });

  it.each(TRIPLES.map((t) => [label(t.from, t.to, t.actor), t] as const))('%s', (name, t) => {
    expect(allowedTargetTransition(t.from, t.to, t.actor)).toBe(SPEC.has(name));
  });

  it('automation never leaves or enters a subject-decided status', () => {
    for (const t of TRIPLES.filter((x) => x.actor === 'automation'))
      expect(allowedTargetTransition(t.from, t.to, 'automation')).toBe(
        t.from === null && t.to === 'proposed',
      );
  });

  it('declined is terminal (a new proposal is a new target)', () => {
    for (const to of TARGET_STATUSES)
      for (const a of TARGET_ACTOR_CLASSES) expect(allowedTargetTransition('declined', to, a)).toBe(false);
  });

  it('maps actions to their target status only where legal', () => {
    expect(targetActionTarget('activate', 'paused', 'subject')).toBe('active');
    expect(targetActionTarget('activate', 'archived', 'subject')).toBe('active');
    expect(targetActionTarget('activate', 'active', 'subject')).toBeNull();
    expect(targetActionTarget('archive', 'active', 'automation')).toBeNull();
    expect(targetActionTarget('accept', 'proposed', 'subject')).toBe('active');
  });
});

describe('precedence: the subject outranks inference', () => {
  it('automation edits only its own proposals while proposed; the subject edits live targets', () => {
    const operator = { kind: 'internal-operator', id: 'op' };
    const robot = { kind: 'workflow', id: 'run_1' };
    for (const status of TARGET_STATUSES)
      for (const origin of TARGET_ORIGINS) {
        const t = { status, origin, createdBy: robot };
        expect(canEditTargetSpec(t, robot), `${status}/${origin}`).toBe(
          status === 'proposed' && origin === 'proposal',
        );
        expect(canEditTargetSpec(t, operator), `${status}/${origin}`).toBe(
          ['proposed', 'active', 'paused'].includes(status),
        );
      }
  });

  it.each([
    ['own proposal, untouched', { subjectEdited: false }, { kind: 'workflow', id: 'run_1' }, true],
    [
      'own proposal, edited by the subject',
      { subjectEdited: true },
      { kind: 'workflow', id: 'run_1' },
      false,
    ],
    ['another automation actor', {}, { kind: 'workflow', id: 'run_2' }, false],
    ['system actor on a workflow proposal', {}, { kind: 'system', id: 'run_1' }, false],
    ['subject on an edited proposal', { subjectEdited: true }, { kind: 'internal-operator', id: 'op' }, true],
  ] as const)('proposal edits — %s', (_name, extra, actor, allowed) => {
    const t = {
      status: 'proposed' as const,
      origin: 'proposal' as const,
      createdBy: { kind: 'workflow', id: 'run_1' },
      ...extra,
    };
    expect(canEditTargetSpec(t, actor)).toBe(allowed);
  });

  it('the internal operator relays the subject; system and workflow actors are automation', () => {
    expect(targetActorClass(UNAUTHENTICATED_INTERNAL_OPERATOR)).toBe('subject');
    expect(targetActorClass(SYSTEM_ACTOR)).toBe('automation');
    expect(targetActorClass({ kind: 'workflow', id: 'run_1' })).toBe('automation');
  });

  it('stated and accepted targets are confirmed; proposals are inferred', () => {
    expect(targetBasis('stated')).toBe('confirmed');
    expect(targetBasis('accepted_proposal')).toBe('confirmed');
    expect(targetBasis('proposal')).toBe('inferred');
  });
});
