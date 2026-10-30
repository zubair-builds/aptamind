import { describe, expect, it } from 'vitest';
import {
  ACTOR_CLASSES,
  confirmationTransition,
  type ActorClass,
  allowedTransition,
  ASSERTION_STATES,
  type AssertionState,
  assertTransition,
  type FromState,
  IllegalTransitionError,
  SUBJECT_ONLY_STATES,
  TRANSITIONS,
  transitionGuard,
} from './transitions';

/**
 * The domain document's §5 transition table, transcribed independently of the implementation
 * (`— → X` is written `new → X`). Every (from, to, actor) triple not listed must be denied.
 *
 *   — → PROPOSED                               automation  first supporting observation
 *   PROPOSED ↔ CONFLICTED                      automation  rival found / gone
 *   PROPOSED/CONFLICTED → SUPERSEDED           automation  newer current_state value; merge
 *   PROPOSED/CONFLICTED → WITHDRAWN            automation  no current support left
 *   WITHDRAWN → PROPOSED                       automation  support returns
 *   WITHDRAWN → SUPERSEDED                     automation  item merged
 *   SUPERSEDED → PROPOSED                      automation  newer current_state support (conditions: revival.ts)
 *   PROPOSED/CONFLICTED/WITHDRAWN → CONFIRMED  subject     confirm
 *   PROPOSED/CONFLICTED → REJECTED             subject     reject
 *   PROPOSED/CONFLICTED → SUPERSEDED           subject     confirm_with_edit
 *   — → CONFIRMED                              subject     confirm_with_edit (edited value, origin confirmation_edit)
 *   CONFIRMED → SUPERSEDED                     subject     other value confirmed; mark_outdated
 *   CONFIRMED → REJECTED                       subject     revoke
 *   REJECTED → CONFIRMED                       subject     confirm (explicit un-reject)
 *   SUPERSEDED → CONFIRMED                     subject     confirm (restore an older value)
 *   SUPERSEDED → REJECTED                      subject     reject (that old value was wrong)
 */
const SPEC_ALLOWED = new Set([
  'new>PROPOSED@automation',
  'PROPOSED>CONFLICTED@automation',
  'CONFLICTED>PROPOSED@automation',
  'PROPOSED>SUPERSEDED@automation',
  'CONFLICTED>SUPERSEDED@automation',
  'PROPOSED>WITHDRAWN@automation',
  'CONFLICTED>WITHDRAWN@automation',
  'WITHDRAWN>PROPOSED@automation',
  'WITHDRAWN>SUPERSEDED@automation',
  'SUPERSEDED>PROPOSED@automation',
  'PROPOSED>CONFIRMED@subject',
  'CONFLICTED>CONFIRMED@subject',
  'WITHDRAWN>CONFIRMED@subject',
  'PROPOSED>REJECTED@subject',
  'CONFLICTED>REJECTED@subject',
  'PROPOSED>SUPERSEDED@subject',
  'CONFLICTED>SUPERSEDED@subject',
  'new>CONFIRMED@subject',
  'CONFIRMED>SUPERSEDED@subject',
  'CONFIRMED>REJECTED@subject',
  'REJECTED>CONFIRMED@subject',
  'SUPERSEDED>CONFIRMED@subject',
  'SUPERSEDED>REJECTED@subject',
]);

const FROM_STATES: FromState[] = [null, ...ASSERTION_STATES];
const label = (from: FromState, to: AssertionState, actor: ActorClass) => `${from ?? 'new'}>${to}@${actor}`;

const TRIPLES = FROM_STATES.flatMap((from) =>
  ASSERTION_STATES.flatMap((to) =>
    ACTOR_CLASSES.map((actor) => ({ from, to, actor, allowed: SPEC_ALLOWED.has(label(from, to, actor)) })),
  ),
);

describe('assertion transitions — full (from, to, actor) table', () => {
  it('covers every triple: 7 from-states × 6 to-states × 2 actor classes', () => {
    expect(TRIPLES).toHaveLength(84);
    expect(TRIPLES.filter((t) => t.allowed)).toHaveLength(SPEC_ALLOWED.size);
  });

  it.each(TRIPLES.map((t) => [label(t.from, t.to, t.actor), t.allowed ? 'allowed' : 'denied', t] as const))(
    '%s is %s',
    (_name, _verdict, t) => {
      expect(allowedTransition(t.from, t.to, t.actor)).toBe(t.allowed);
      if (t.allowed) expect(() => assertTransition(t.from, t.to, t.actor)).not.toThrow();
      else expect(() => assertTransition(t.from, t.to, t.actor)).toThrow(IllegalTransitionError);
    },
  );

  it('the implementation table lists exactly the specified rows (no duplicates, no extras)', () => {
    const impl = TRANSITIONS.map((r) => label(r.from, r.to, r.actor));
    expect(new Set(impl).size).toBe(impl.length);
    expect(new Set(impl)).toEqual(SPEC_ALLOWED);
  });
});

describe('assertion transitions — invariants', () => {
  it('PL-3: only the subject enters or leaves CONFIRMED / REJECTED', () => {
    for (const t of TRIPLES) {
      const touchesProtected =
        (t.from !== null && SUBJECT_ONLY_STATES.includes(t.from)) || SUBJECT_ONLY_STATES.includes(t.to);
      if (touchesProtected && t.actor === 'automation') {
        expect(allowedTransition(t.from, t.to, t.actor), label(t.from, t.to, t.actor)).toBe(false);
      }
    }
  });

  it('automation can never create an assertion in any state but PROPOSED', () => {
    for (const to of ASSERTION_STATES)
      expect(allowedTransition(null, to, 'automation')).toBe(to === 'PROPOSED');
  });

  it('no self-transitions', () => {
    for (const s of ASSERTION_STATES)
      for (const a of ACTOR_CLASSES) expect(allowedTransition(s, s, a)).toBe(false);
  });

  it('SUPERSEDED leaves only by automation revival (→ PROPOSED) or a subject confirm / reject', () => {
    for (const to of ASSERTION_STATES)
      for (const a of ACTOR_CLASSES)
        expect(allowedTransition('SUPERSEDED', to, a), `SUPERSEDED>${to}@${a}`).toBe(
          (to === 'PROPOSED' && a === 'automation') ||
            ((to === 'CONFIRMED' || to === 'REJECTED') && a === 'subject'),
        );
  });

  it('a rejected assertion is only ever re-opened by the subject confirming it (R-14)', () => {
    for (const to of ASSERTION_STATES)
      for (const a of ACTOR_CLASSES)
        expect(allowedTransition('REJECTED', to, a)).toBe(to === 'CONFIRMED' && a === 'subject');
  });

  it('illegal transitions carry a code and enums only', () => {
    try {
      assertTransition('CONFIRMED', 'SUPERSEDED', 'automation');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      expect((err as IllegalTransitionError).code).toBe('illegal_transition');
      expect((err as Error).message).toBe(
        'illegal assertion transition CONFIRMED -> SUPERSEDED by automation',
      );
    }
  });
});

describe('transitionGuard', () => {
  it('automation writes never match a subject-only state', () => {
    expect(transitionGuard('PROPOSED', 'CONFLICTED', 'automation')).toEqual({
      state: { $eq: 'PROPOSED', $nin: ['CONFIRMED', 'REJECTED'] },
    });
  });

  it('subject writes guard on the expected state', () => {
    expect(transitionGuard('CONFIRMED', 'REJECTED', 'subject')).toEqual({ state: 'CONFIRMED' });
  });

  it('refuses to build a guard for an illegal transition', () => {
    expect(() => transitionGuard('CONFIRMED', 'SUPERSEDED', 'automation')).toThrow(IllegalTransitionError);
    expect(() => transitionGuard('REJECTED', 'PROPOSED', 'automation')).toThrow(IllegalTransitionError);
  });
});

describe('confirmationTransition (subject confirm of a value that may already exist)', () => {
  it('creates only when no assertion with that value exists', () => {
    expect(confirmationTransition(null)).toEqual({ from: null, to: 'CONFIRMED' });
  });

  it('otherwise uses the existing assertion own transition', () => {
    for (const s of ['PROPOSED', 'CONFLICTED', 'WITHDRAWN', 'REJECTED', 'SUPERSEDED'] as const)
      expect(confirmationTransition(s)).toEqual({ from: s, to: 'CONFIRMED' });
  });

  it('confirming an already confirmed value is no transition', () => {
    expect(confirmationTransition('CONFIRMED')).toEqual({ noop: true });
  });
});
