import { describe, expect, it } from 'vitest';
import { basisOf, OBSERVATION_MODES, type ObservationMode } from '../contracts/basis';
import { IllegalTransitionError } from '../assertions/transitions';
import { revivalGuard } from '../assertions/revival';
import {
  type AssertionSnapshot,
  canonicalFingerprint,
  POLICY_VERSION,
  PRECEDENCE_LADDER,
  PROF_REC_1,
  reconcileItem,
  type ReconcileInput,
} from './policy';
import { requestDedupeKey, requestPriority } from './requests';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const support = (asOf: string, modes: ObservationMode[] = ['extracted'], extra: object = {}) => ({
  count: 1,
  modes,
  sourceIds: ['psrc_1'],
  latestAsOf: d(asOf),
  ...extra,
});
const LON = { city: 'London', country: 'GB' };
const BER = { city: 'Berlin', country: 'DE' };
const item = (extra: Partial<ReconcileInput['item']> = {}): ReconcileInput['item'] => ({
  itemId: 'pitm_1',
  claimType: 'location.current',
  active: true,
  ...extra,
});

describe('policy constants', () => {
  it('is prof-rec-1 with the PL-1 ladder', () => {
    expect(POLICY_VERSION).toBe('prof-rec-1');
    expect(PROF_REC_1.version).toBe('prof-rec-1');
    expect(PRECEDENCE_LADDER).toEqual(['confirmed', 'stated', 'extracted', 'inferred']);
    expect(PROF_REC_1.revivalGuard).toBe(revivalGuard);
  });

  it('computes the same basis as basisOf under the default ladder', () => {
    const subsets: ObservationMode[][] = [[]];
    for (const m of OBSERVATION_MODES) for (const s of [...subsets]) subsets.push([...s, m]);
    for (const modes of subsets)
      for (const state of ['PROPOSED', 'CONFIRMED'] as const) {
        const r = reconcileItem({
          item: item({ claimType: 'positioning.headline' }),
          assertions: [
            state === 'CONFIRMED'
              ? {
                  assertionId: 'pasr_a',
                  value: { text: 'x' },
                  state,
                  confirmedAt: d('2024-02-01'),
                  support: { count: 1, modes, sourceIds: ['psrc_1'], latestAsOf: d('2024-01-01') },
                }
              : {
                  assertionId: 'pasr_a',
                  value: { text: 'x' },
                  state,
                  support: { count: 1, modes, sourceIds: ['psrc_1'], latestAsOf: d('2024-01-01') },
                },
          ],
        });
        expect(r.canonical.basis ?? null).toBe(
          modes.length || state === 'CONFIRMED' ? basisOf(state, modes) : null,
        );
      }
  });
});

describe('reconcileItem', () => {
  it('returns plain typed decisions: canonical, guarded transitions, requests and events', () => {
    const r = reconcileItem({
      item: item(),
      assertions: [
        { assertionId: 'pasr_a', value: LON, state: 'PROPOSED', support: support('2022-01-01') },
        { assertionId: 'pasr_b', value: BER, state: 'PROPOSED', support: support('2023-01-01') },
      ],
    });
    expect(r.policyVersion).toBe('prof-rec-1');
    expect(r.canonical).toMatchObject({
      value: BER,
      status: 'known',
      basis: 'extracted',
      assertionId: 'pasr_b',
    });
    expect(r.transitions).toEqual([
      {
        assertionId: 'pasr_a',
        from: 'PROPOSED',
        to: 'SUPERSEDED',
        reason: 'newer_state',
        guard: { state: { $eq: 'PROPOSED', $nin: ['CONFIRMED', 'REJECTED'] } },
        supersession: { cause: 'newer_state', supersededBy: 'pasr_b', supersededAtAsOf: d('2023-01-01') },
      },
    ]);
    expect(r.changed).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(['assertion.transitioned', 'item.canonical_changed']);
    expect(r.requests.open).toEqual([
      {
        type: 'confirm_new',
        dedupeKey: 'confirm_new:unconfirmed_material:pitm_1:pasr_b',
        itemIds: ['pitm_1'],
        assertionIds: ['pasr_b'],
        priority: 3,
        params: { reason: 'unconfirmed_material', roles: [{ assertionId: 'pasr_b', role: 'candidate' }] },
      },
    ]);
  });

  it('commits nothing when the recompute equals the stored result', () => {
    const input: ReconcileInput = {
      item: item(),
      assertions: [{ assertionId: 'pasr_a', value: LON, state: 'PROPOSED', support: support('2022-01-01') }],
    };
    const first = reconcileItem(input);
    const again = reconcileItem({
      ...input,
      item: item({ canonical: first.canonical }),
      openRequests: first.requests.open,
    });
    expect(again.changed).toBe(false);
    expect(again.transitions).toEqual([]);
    expect(again.events).toEqual([]);
    expect(again.requests).toEqual({ open: [], keep: [first.requests.open[0]?.dedupeKey], close: [] });
    expect(canonicalFingerprint(again.canonical)).toBe(canonicalFingerprint(first.canonical));
  });

  it('closes moot reconciler requests as superseded and never touches other request types', () => {
    const r = reconcileItem({
      item: item(),
      assertions: [{ assertionId: 'pasr_a', value: LON, state: 'PROPOSED', support: support('2022-01-01') }],
      openRequests: [
        {
          type: 'reconfirm',
          dedupeKey: 'reconfirm:challenges_confirmed:pitm_1:pasr_a,pasr_z',
          itemIds: ['pitm_1'],
          assertionIds: ['pasr_a', 'pasr_z'],
        },
        {
          type: 'same_item',
          dedupeKey: 'same_item:x:pitm_1,pitm_2:',
          itemIds: ['pitm_1', 'pitm_2'],
          assertionIds: [],
        },
      ],
    });
    expect(r.requests.close).toEqual([
      {
        dedupeKey: 'reconfirm:challenges_confirmed:pitm_1:pasr_a,pasr_z',
        type: 'reconfirm',
        reason: 'superseded',
      },
    ]);
  });

  it('skips inactive (merged) items and closes their reconciler requests', () => {
    const r = reconcileItem({
      item: item({ active: false }),
      assertions: [{ assertionId: 'pasr_a', value: LON, state: 'PROPOSED', support: support('2022-01-01') }],
      openRequests: [
        {
          type: 'confirm_new',
          dedupeKey: 'confirm_new:unconfirmed_material:pitm_1:pasr_a',
          itemIds: ['pitm_1'],
          assertionIds: ['pasr_a'],
        },
      ],
    });
    expect(r.skipped).toBe('item_inactive');
    expect(r.transitions).toEqual([]);
    expect(r.requests.close).toHaveLength(1);
  });

  it('never automates a confirmed or rejected assertion, even under a broken ladder', () => {
    const assertions: AssertionSnapshot[] = [
      {
        assertionId: 'pasr_c',
        value: LON,
        state: 'CONFIRMED',
        confirmedAt: d('2022-01-01'),
        support: support('2021-01-01'),
      },
      { assertionId: 'pasr_s', value: BER, state: 'PROPOSED', support: support('2024-01-01', ['stated']) },
    ];
    // A ladder that ranks stated above confirmed would supersede the confirmed value: refused.
    expect(() =>
      reconcileItem(
        { item: item(), assertions },
        { ...PROF_REC_1, ladder: ['stated', 'confirmed', 'extracted', 'inferred'] },
      ),
    ).toThrow(IllegalTransitionError);
    const r = reconcileItem({ item: item(), assertions });
    expect(r.transitions.every((t) => t.assertionId !== 'pasr_c')).toBe(true);
    expect(r.canonical).toMatchObject({ value: LON, basis: 'confirmed' });
  });

  it('obtains every revival guard from revivalGuard (never transitionGuard directly)', () => {
    const calls: unknown[] = [];
    const r = reconcileItem(
      {
        item: item(),
        assertions: [
          {
            assertionId: 'pasr_a',
            value: LON,
            state: 'SUPERSEDED',
            supersession: { cause: 'newer_state', supersededBy: 'pasr_b', supersededAtAsOf: d('2023-01-01') },
            support: support('2024-01-01'),
          },
          { assertionId: 'pasr_b', value: BER, state: 'PROPOSED', support: support('2023-01-01') },
        ],
      },
      {
        ...PROF_REC_1,
        revivalGuard: (i) => {
          calls.push(i);
          return revivalGuard(i);
        },
      },
    );
    expect(calls).toHaveLength(1);
    const revival = r.transitions.find((t) => t.reason === 'revived');
    expect(revival).toMatchObject({
      from: 'SUPERSEDED',
      to: 'PROPOSED',
      prior: { cause: 'newer_state', supersededBy: 'pasr_b', supersededAtAsOf: d('2023-01-01') },
    });
    expect(r.events.find((e) => e.type === 'assertion.revived')?.prior?.supersededBy).toBe('pasr_b');
  });

  it('refuses a revival transition that did not come from a revival decision', () => {
    expect(() =>
      reconcileItem(
        {
          item: item(),
          assertions: [
            {
              assertionId: 'pasr_a',
              value: LON,
              state: 'SUPERSEDED',
              supersession: { cause: 'newer_state', supersededAtAsOf: d('2023-01-01') },
              support: support('2024-01-01'),
            },
          ],
        },
        // A broken guard that says "revive" without a write filter.
        { ...PROF_REC_1, revivalGuard: () => ({ revive: true, guard: undefined as never }) },
      ),
    ).toThrow(/revivalGuard/);
  });
});

describe('seams for P3.2', () => {
  it('a confirmed assertion without confirmedAt is refused', () => {
    expect(() =>
      reconcileItem({
        item: item(),
        assertions: [
          { assertionId: 'pasr_c', value: LON, state: 'CONFIRMED', support: support('2022-01-01') } as never,
        ],
      }),
    ).toThrow(/confirmedAt/);
  });

  it('reports corroboration-only changes as derivedChanged, not changed', () => {
    const a = {
      assertionId: 'pasr_a',
      value: LON,
      state: 'PROPOSED' as const,
      support: support('2022-01-01'),
    };
    const first = reconcileItem({ item: item(), assertions: [a] });
    const again = reconcileItem({
      item: item({ canonical: first.canonical }),
      assertions: [{ ...a, support: { ...a.support, count: 2, sourceIds: ['psrc_1', 'psrc_2'] } }],
      openRequests: first.requests.open,
    });
    expect(again.changed).toBe(false);
    expect(again.derivedChanged).toBe(true);
    expect(again.events).toEqual([]);
    expect(again.canonical.confidence.reasons).toContain('2 sources agree');
  });

  it('counts distinct sources across supporting assertions', () => {
    const r = reconcileItem({
      item: item(),
      assertions: [
        { assertionId: 'pasr_a', value: LON, state: 'PROPOSED', support: support('2022-01-01') },
        {
          assertionId: 'pasr_b',
          value: { country: 'GB' },
          state: 'PROPOSED',
          support: support('2022-01-01'),
        },
      ],
    });
    expect(r.canonical.supportingAssertionIds).toEqual(['pasr_a', 'pasr_b']);
    expect(r.canonical.confidence.reasons).not.toContain('2 sources agree');
  });
});

describe('requests', () => {
  it('dedupe keys use codes and ids only, sorted; priority = materiality × kind weight', () => {
    expect(requestDedupeKey('reconfirm', 'challenges_confirmed', ['pitm_1'], ['pasr_b', 'pasr_a'])).toBe(
      'reconfirm:challenges_confirmed:pitm_1:pasr_a,pasr_b',
    );
    expect(requestPriority('location.current', 'reconfirm')).toBe(12);
    expect(requestPriority('skill', 'reconfirm')).toBe(4);
    expect(requestPriority('experience.role', 'confirm_new')).toBe(3);
  });
});
