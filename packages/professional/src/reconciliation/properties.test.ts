import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@aptamind/contracts';
import type { ObservationMode } from '../contracts/basis';
import type { ClaimType } from '../contracts/claims';
import { ItemSimulator, type Step } from '../golden/simulator';
import { type AssertionSnapshot, reconcileItem } from './policy';

/**
 * Property-style checks over generated evidence sequences (seeded, deterministic):
 * - automation never changes a CONFIRMED canonical value, never moves a CONFIRMED or REJECTED
 *   assertion, and every transition applies through its write guard;
 * - every result is a fixed point (the simulator checks this after each step);
 * - the result does not depend on the order assertions are read in.
 */

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const role = (title: string, key: string, start: object, end: object) => ({
  organization: { name: 'Northwind Labs', key: 'northwind-labs' },
  title,
  titleKey: key,
  start,
  end,
});

const POOLS: Record<string, { claimType: ClaimType; values: Record<string, unknown> }> = {
  current_state: {
    claimType: 'location.current',
    values: {
      V0: { city: 'London', country: 'GB' },
      V1: { city: 'Berlin', country: 'DE' },
      V2: { country: 'DE' },
      V3: { city: 'Paris', country: 'FR' },
      V4: { city: 'Lyon', country: 'FR' },
      V5: { country: 'FR' },
    },
  },
  historical: {
    claimType: 'experience.role',
    values: {
      V0: role('Data Analyst', 'data-analyst', { year: 2019 }, { year: 2021 }),
      V1: role('Data Analyst', 'data-analyst', { year: 2019, month: 3 }, { year: 2021 }),
      V2: role('Senior Data Analyst', 'senior-data-analyst', { year: 2019 }, { year: 2021 }),
      V3: role('Data Analyst', 'data-analyst', { year: 2019 }, { open: true, asOf: '2020-06-01T00:00:00Z' }),
      V4: role('Data Analyst', 'data-analyst', { year: 2018 }, { year: 2022 }),
    },
  },
  set_member: {
    claimType: 'language',
    values: {
      V0: { label: 'French', language: 'french', proficiency: 'fluent' },
      V1: { label: 'French', language: 'french', proficiency: 'professional' },
      V2: { label: 'Francais', language: 'french', proficiency: 'basic' },
      V3: { label: 'French', language: 'french', proficiency: 'cefr:B2' },
      V4: { label: 'French', language: 'french', proficiency: 'native' },
    },
  },
};

const MODES: ObservationMode[] = ['stated', 'extracted', 'inferred'];

function randomAutomationStep(rand: () => number, n: number, size = 5): Step {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const source = `s${Math.floor(rand() * 6)}`;
  const r = rand();
  if (r < 0.6) {
    const year = 2015 + Math.floor(rand() * 12);
    const month = 1 + Math.floor(rand() * 12);
    return {
      observe: {
        value: `V${Math.floor(rand() * size)}`,
        source: `${source}_${n}`,
        asOf: `${year}-${String(month).padStart(2, '0')}-01`,
        mode: pick(MODES),
        declared: rand() < 0.5,
        authorship: rand() < 0.7 ? 'subject' : 'other',
        unverified: rand() < 0.1,
      },
    };
  }
  if (r < 0.75) return { reprocess: { source, extractor: 2 + n, drop: rand() < 0.3 ? ['V0', 'V1'] : [] } };
  if (r < 0.85) return { quarantine: source };
  if (r < 0.95) return { unquarantine: source };
  return { reconcile: true };
}

/** Observations in the generator use per-step source names; re-map some onto shared ones. */
function withSharedSources(step: Step, rand: () => number): Step {
  if ('observe' in step && rand() < 0.5)
    return { observe: { ...step.observe, source: `s${Math.floor(rand() * 6)}` } };
  return step;
}

/** Coarse + two precise values of one country: the pairwise-merge trap (A-T3). */
const CITY_POOL = {
  claimType: 'location.current' as ClaimType,
  values: {
    V0: { country: 'DE' },
    V1: { city: 'Berlin', country: 'DE' },
    V2: { city: 'Munich', country: 'DE' },
    V3: { region: 'Bavaria', country: 'DE' },
    V4: { city: 'London', country: 'GB' },
  },
};
const ALL_POOLS = { ...POOLS, current_state_cities: CITY_POOL };

/** A random subject decision (A-T2); illegal ones for the current state are skipped. */
function randomSubjectStep(rand: () => number, n: number): Step {
  const label = `V${Math.floor(rand() * 5)}`;
  const at = `${2020 + Math.floor(n / 3)}-${String(1 + (n % 12)).padStart(2, '0')}-15`;
  const r = rand();
  if (r < 0.3) return { confirm: { value: label, at } };
  if (r < 0.5) return { mark_outdated: { value: label, validTo: at, at } };
  if (r < 0.7) return { reject: { value: label, at } }; // revoke when CONFIRMED
  if (r < 0.85) return { reaffirm: { value: label, at } };
  return { still_rejected: { value: label, at } };
}

describe('property: automation never changes confirmed truth', () => {
  for (const [fieldClass, pool] of Object.entries(ALL_POOLS)) {
    it(`${fieldClass}: 150 generated sequences of evidence and subject decisions after a confirmation`, () => {
      for (let seed = 1; seed <= 150; seed++) {
        const rand = prng(seed * 7919 + fieldClass.length);
        const sim = new ItemSimulator(pool.claimType, pool.values);
        const first = `V${Math.floor(rand() * 5)}`;
        const problems: string[] = [];
        problems.push(
          ...sim.apply({ observe: { value: first, source: 'cv0', asOf: '2020-01-01' } }).problems,
        );
        problems.push(...sim.apply({ confirm: { value: first, at: '2020-02-01' } }).problems);
        for (let n = 0; n < 30; n++) {
          if (rand() < 0.2) {
            // Subject decisions change confirmation state; automation must then respect the new one.
            try {
              problems.push(...sim.apply(randomSubjectStep(rand, n)).problems);
            } catch {
              /* not a legal decision in the current state */
            }
            continue;
          }
          const decided = Object.fromEntries(
            sim
              .assertionLabels()
              .map((l) => [l, sim.state(l)])
              .filter(([, st]) => st === 'CONFIRMED' || st === 'REJECTED'),
          );
          const { result, problems: p } = sim.apply(
            withSharedSources(randomAutomationStep(rand, n, Object.keys(pool.values).length), rand),
          );
          problems.push(...p);
          for (const t of result.transitions) {
            expect(['CONFIRMED', 'REJECTED']).not.toContain(t.from);
            expect(['CONFIRMED', 'REJECTED']).not.toContain(t.to);
          }
          // Automation never moves anything into or out of CONFIRMED / REJECTED …
          const after = Object.fromEntries(
            sim
              .assertionLabels()
              .map((l) => [l, sim.state(l)])
              .filter(([, st]) => st === 'CONFIRMED' || st === 'REJECTED'),
          );
          expect(after, `seed ${seed} step ${n}`).toEqual(decided);
          // … and a confirmed value is always the canonical value.
          const confirmed = Object.entries(after).filter(([, st]) => st === 'CONFIRMED');
          if (confirmed.length === 1) {
            expect(sim.canonical?.basis, `seed ${seed} step ${n}`).toBe('confirmed');
            expect(canonicalJson(sim.canonical?.value), `seed ${seed} step ${n}`).toBe(
              canonicalJson(sim.valueOf((confirmed[0] as [string, string])[0])),
            );
          }
        }
        expect(problems, `seed ${seed}`).toEqual([]);
      }
    });
  }

  it('a REJECTED value stays rejected and never becomes the canonical value', () => {
    for (const pool of [POOLS.current_state, CITY_POOL] as {
      claimType: ClaimType;
      values: Record<string, unknown>;
    }[])
      for (let seed = 1; seed <= 100; seed++) {
        const rand = prng(seed * 104729);
        const sim = new ItemSimulator(pool.claimType, pool.values);
        sim.apply({ observe: { value: 'V1', source: 'cv0', asOf: '2020-01-01' } });
        sim.apply({ reject: { value: 'V1', at: '2020-02-01' } });
        const rejected = canonicalJson(sim.valueOf('V1'));
        const problems: string[] = [];
        for (let n = 0; n < 25; n++) {
          problems.push(
            ...sim.apply(
              withSharedSources(randomAutomationStep(rand, n, Object.keys(pool.values).length), rand),
            ).problems,
          );
          expect(sim.state('V1')).toBe('REJECTED');
          expect(canonicalJson(sim.canonical?.value ?? null), `seed ${seed} step ${n}`).not.toBe(rejected);
        }
        expect(problems, `seed ${seed}`).toEqual([]);
      }
  });
});

describe('property: unconfirmed evidence sequences', () => {
  for (const [fieldClass, pool] of Object.entries(ALL_POOLS)) {
    it(`${fieldClass}: guarded, fixed-point results and no automation confirmation`, () => {
      for (let seed = 1; seed <= 150; seed++) {
        const rand = prng(seed * 31337 + fieldClass.length);
        const sim = new ItemSimulator(pool.claimType, pool.values);
        const problems: string[] = [];
        for (let n = 0; n < 25; n++) {
          const { result, problems: p } = sim.apply(
            withSharedSources(randomAutomationStep(rand, n, Object.keys(pool.values).length), rand),
          );
          problems.push(...p);
          for (const t of result.transitions) expect(['CONFIRMED', 'REJECTED']).not.toContain(t.to);
          const c = sim.canonical;
          if (c) {
            expect(c.basis === 'confirmed').toBe(false);
            expect(c.value === null).toBe(c.status !== 'known');
          }
        }
        expect(problems, `seed ${seed}`).toEqual([]);
      }
    });
  }

  it('the result does not depend on the order assertions are read in', () => {
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    const support = (asOf: string, mode: ObservationMode) => ({
      count: 1,
      modes: [mode],
      sourceIds: ['psrc_1'],
      latestAsOf: d(asOf),
    });
    const assertions: AssertionSnapshot[] = [
      {
        assertionId: 'pasr_a',
        value: { city: 'London', country: 'GB' },
        state: 'PROPOSED',
        support: support('2022-01-01', 'extracted'),
      },
      {
        assertionId: 'pasr_b',
        value: { city: 'Berlin', country: 'DE' },
        state: 'PROPOSED',
        support: support('2023-01-01', 'extracted'),
      },
      {
        assertionId: 'pasr_c',
        value: { country: 'DE' },
        state: 'CONFLICTED',
        support: support('2024-01-01', 'inferred'),
      },
      {
        assertionId: 'pasr_d',
        value: { city: 'Paris', country: 'FR' },
        state: 'WITHDRAWN',
        support: support('2021-01-01', 'stated'),
      },
    ];
    const run = (xs: AssertionSnapshot[]) =>
      canonicalJson(
        reconcileItem({
          item: { itemId: 'pitm_x', claimType: 'location.current', active: true },
          assertions: xs,
        }),
      );
    const expected = run(assertions);
    const rand = prng(42);
    for (let i = 0; i < 20; i++) {
      const shuffled = [...assertions].sort(() => rand() - 0.5);
      expect(run(shuffled)).toBe(expected);
    }
  });
});

describe('property: results do not depend on assertion ids (T1)', () => {
  const d0 = Date.UTC(2018, 0, 1);
  const pools: [ClaimType, unknown[]][] = [
    [
      'location.current',
      [
        { country: 'DE' },
        { city: 'Berlin', country: 'DE' },
        { city: 'Munich', country: 'DE' },
        { region: 'Bavaria', country: 'DE' },
        { city: 'Paris', country: 'FR' },
      ],
    ],
    ['experience.role', Object.values(POOLS.historical?.values ?? {}).map((v) => parseRole(v))],
    ['language', Object.values(POOLS.set_member?.values ?? {})],
  ];

  function parseRole(v: unknown): unknown {
    const r = v as { end: { open?: boolean; asOf?: string } };
    return r.end.open ? { ...r, end: { open: true, asOf: new Date(r.end.asOf as string) } } : r;
  }

  function generate(rand: () => number, values: unknown[]): AssertionSnapshot[] {
    const n = 2 + Math.floor(rand() * (values.length - 1));
    const chosen = [...values].sort(() => rand() - 0.5).slice(0, n);
    const confirmedAt = rand() < 0.3 ? Math.floor(rand() * n) : -1;
    return chosen.map((value, i) => {
      const asOf = new Date(d0 + Math.floor(rand() * 6) * 180 * 86400000);
      const count = rand() < 0.15 ? 0 : 1 + Math.floor(rand() * 2);
      const mode = MODES[Math.floor(rand() * MODES.length)] as ObservationMode;
      const base = {
        assertionId: `pasr_g${i}`,
        value,
        support: {
          count,
          modes: count ? [mode] : [],
          sourceIds: Array.from({ length: count }, (_, k) => `psrc_${k}`),
          latestAsOf: count ? asOf : null,
          latestDeclaredAsOf: count && rand() < 0.5 ? asOf : null,
          latestSubjectAuthoredAsOf: count ? asOf : null,
        },
      };
      if (i === confirmedAt)
        return { ...base, state: 'CONFIRMED' as const, confirmedAt: new Date(asOf.getTime() + 86400000) };
      const r = rand();
      if (r < 0.15)
        return {
          ...base,
          state: 'SUPERSEDED' as const,
          supersession: { cause: 'newer_state' as const, supersededAtAsOf: new Date(d0 + 365 * 86400000) },
        };
      if (r < 0.25) return { ...base, state: 'REJECTED' as const, stateChangedAt: new Date(d0) };
      return { ...base, state: (r < 0.5 ? 'CONFLICTED' : 'PROPOSED') as 'PROPOSED' | 'CONFLICTED' };
    });
  }

  function normalized(claimType: ClaimType, xs: AssertionSnapshot[], rename: (id: string) => string): string {
    const back = new Map(xs.map((a) => [rename(a.assertionId), a.assertionId]));
    const m = (id: string | null | undefined) => (id ? (back.get(id) ?? id) : id);
    const r = reconcileItem({
      item: { itemId: 'pitm_x', claimType, active: true },
      assertions: xs.map((a) => ({ ...a, assertionId: rename(a.assertionId) })),
    });
    const c = r.canonical;
    const byAssertion = new Map<string, string[]>();
    for (const t of r.transitions) {
      const k = m(t.assertionId) as string;
      byAssertion.set(k, [
        ...(byAssertion.get(k) ?? []),
        `${t.from}>${t.to}:${t.reason}:${m(t.supersession?.supersededBy) ?? ''}`,
      ]);
    }
    return canonicalJson({
      value: c.value,
      status: c.status,
      basis: c.basis,
      assertionId: m(c.assertionId),
      supporting: c.supportingAssertionIds.map(m).sort(),
      refinements: c.refinements.map(m).sort(),
      conflicts: c.conflicts
        .map((k) => `${k.kind}:${k.assertionIds.map(m).sort().join(',')}@${k.attributes.join(',')}`)
        .sort(),
      attributes: c.attributes,
      transitions: [...byAssertion.entries()].sort(),
      requests: r.requests.open
        .map((q) => `${q.type}:${q.params.reason}:${q.assertionIds.map(m).sort().join(',')}`)
        .sort(),
    });
  }

  for (const [claimType, values] of pools) {
    it(`${claimType}: 200 generated assertion sets, ids permuted`, () => {
      for (let seed = 1; seed <= 200; seed++) {
        const rand = prng(seed * 6007 + claimType.length);
        const xs = generate(rand, values);
        const perm = [...xs.map((a) => a.assertionId)].sort(() => rand() - 0.5);
        const rename = (id: string) => `pasr_z${String(perm.indexOf(id)).padStart(2, '0')}x`;
        expect(normalized(claimType, xs, rename), `seed ${seed}`).toBe(normalized(claimType, xs, (id) => id));
      }
    });
  }
});
