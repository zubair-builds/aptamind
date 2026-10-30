import { describe, expect, it } from 'vitest';
import type { SourceStanding } from './authority';
import type { CopyBoard } from './job.schema';
import {
  authoritativeEvidenceAt,
  type DeriveJob,
  deriveLifecycle,
  type EvidenceItem,
  finalizeFold,
  foldEvidence,
  initialFoldState,
} from './lifecycle';

/**
 * The lifecycle is DERIVED from an order-independent evidence set (DECISION_LOG 6a01b36). These
 * tests state the rules on evidence sets, and prove that no permutation of a set changes the
 * result.
 */

const t = (h: number) => new Date(Date.UTC(2026, 0, 1) + h * 3600_000);
const A: CopyBoard = {
  endpointUrl: 'https://boards.test/a',
  boardToken: 'a',
  apiBase: 'https://boards.test',
};
const B: CopyBoard = {
  endpointUrl: 'https://boards.test/b',
  boardToken: 'b',
  apiBase: 'https://boards.test',
};
const source = (
  tier: SourceStanding['authority']['tier'],
  over: Partial<SourceStanding> = {},
): SourceStanding => ({
  enabled: true,
  category: 'job_source',
  provider: 'greenhouse',
  authority: { tier, listingIsComplete: tier === 'official_ats' },
  ...over,
});
const SOURCES = new Map<string, SourceStanding>([
  ['ats', source('official_ats')],
  ['ats2', source('official_ats')],
  ['site', source('official_site', { provider: 'careers_page' })],
  ['agg', source('third_party', { provider: 'aggregator' })],
]);
const JOB = {
  copies: [
    { key: 'ats:1', sourceId: 'ats', board: A },
    { key: 'ats2:1', sourceId: 'ats2', board: A },
    { key: 'site:1', sourceId: 'site', board: A },
    { key: 'agg:1', sourceId: 'agg', board: A },
  ],
  firstSeenAt: t(0),
  lastSeenAt: t(0),
};

let n = 0;
const ev = (e: Partial<EvidenceItem> & Pick<EvidenceItem, 'kind' | 'outcome'>): EvidenceItem => ({
  _id: `e${String(n++).padStart(4, '0')}`,
  copyKey: 'ats:1',
  sourceId: 'ats',
  board: A,
  at: t(0),
  ...e,
});
const seen = (h: number, over: Partial<EvidenceItem> = {}) =>
  ev({ kind: 'listing', outcome: 'present', at: t(h), ...over });
const absent = (h: number, over: Partial<EvidenceItem> = {}) =>
  ev({ kind: 'listing', outcome: 'absent', at: t(h), ...over });
const live = (h: number, over: Partial<EvidenceItem> = {}) =>
  ev({ kind: 'verification', outcome: 'live', at: t(h), ...over });
const notFound = (h: number, over: Partial<EvidenceItem> = {}) =>
  ev({ kind: 'verification', outcome: 'not_found', at: t(h), ...over });
const derive = (evidence: EvidenceItem[], now = t(10), sources = SOURCES, job: DeriveJob = JOB) =>
  deriveLifecycle(evidence, sources, now, job).lifecycle;

describe('derived job lifecycle: the rules', () => {
  it('starts VERIFIED_LIVE on authoritative evidence and DISCOVERED on third-party only', () => {
    expect(derive([seen(0)]).state).toBe('VERIFIED_LIVE');
    expect(derive([seen(0, { copyKey: 'agg:1', sourceId: 'agg' })]).state).toBe('DISCOVERED');
    expect(derive([]).state).toBe('DISCOVERED');
  });

  it('one absence: POSSIBLY_STALE; absence alone never closes (L1)', () => {
    expect(derive([seen(0), absent(6)])).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 1 });
    expect(derive([seen(0), absent(6), absent(7), absent(8)])).toMatchObject({
      state: 'POSSIBLY_STALE',
      consecutiveAbsences: 3,
      absentSince: t(6),
    });
  });

  it('two absences AND a not_found since the first close; a not_found before the run does not corroborate', () => {
    expect(derive([seen(0), absent(2), notFound(3), absent(4)]).state).toBe('CLOSED');
    expect(derive([seen(0), notFound(1), seen(2), absent(3), absent(4)])).toMatchObject({
      state: 'POSSIBLY_STALE',
      consecutiveAbsences: 2,
    });
  });

  it('two consecutive not_founds close; one not_found while absent from listings closes at once', () => {
    expect(derive([seen(0), notFound(1)])).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 1 });
    expect(derive([seen(0), notFound(1), notFound(2)]).closeReason).toBe(
      'not found in 2 consecutive verifications',
    );
    expect(derive([seen(0), absent(1), notFound(2)]).closeReason).toBe(
      'verified not found and absent from listing',
    );
  });

  it('a positive ends every negative before it; negatives count only after the latest positive', () => {
    expect(derive([seen(0), notFound(1), live(2), notFound(3)])).toMatchObject({
      state: 'POSSIBLY_STALE',
      consecutiveNotFound: 1,
    });
    expect(derive([seen(0), absent(1), live(2), absent(3)])).toMatchObject({
      consecutiveAbsences: 1,
      absentSince: t(3),
    });
    // A tie never closes: the positive at the same instant wins.
    expect(derive([seen(0), notFound(1), notFound(2), live(2)]).state).not.toBe('CLOSED');
  });

  it('a skipped entry ends negatives but is no verification (U1)', () => {
    expect(derive([seen(0), absent(1), absent(2), seen(3, { skipped: true })])).toMatchObject({
      consecutiveAbsences: 0,
      lastVerifiedAt: t(0),
    });
    expect(derive([seen(0), absent(1), seen(2, { skipped: true }), absent(3)])).toMatchObject({
      consecutiveAbsences: 1,
      absentSince: t(3),
    });
  });

  it('a board-derived not_found only corroborates a job-level absence run of two (b7f1a76)', () => {
    expect(derive([seen(0), absent(1), notFound(2, { boardDerived: true })])).toMatchObject({
      state: 'POSSIBLY_STALE',
      consecutiveNotFound: 0,
    });
    expect(derive([seen(0), absent(1), absent(2), notFound(3, { boardDerived: true })]).state).toBe('CLOSED');
  });

  it('another counting copy present means the job is still listed; a copy frozen by a disable does not count after it', () => {
    const site = seen(0, { copyKey: 'site:1', sourceId: 'site' });
    expect(derive([seen(0), site, absent(1), absent(2)])).toMatchObject({ consecutiveAbsences: 0 });
    // The site source was enabled when it saw the job, then disabled at 0.5: from then on its copy
    // is unknown, so the later absences count (and the site sighting itself still counts).
    const disabled = new Map(SOURCES).set(
      'site',
      source('official_site', {
        provider: 'careers_page',
        enabled: false,
        standingHistory: [
          { at: t(-1), enabled: true },
          { at: t(0.5), enabled: false },
        ],
      }),
    );
    expect(derive([seen(0), site, absent(1), absent(2)], t(10), disabled)).toMatchObject({
      consecutiveAbsences: 2,
    });
  });

  it('one listing lacking two copies of the job is one absence', () => {
    const job = { ...JOB, copies: [...JOB.copies, { key: 'ats:2', sourceId: 'ats', board: A }] };
    expect(
      derive(
        [seen(0), seen(0, { copyKey: 'ats:2' }), absent(1), absent(1, { copyKey: 'ats:2' })],
        t(10),
        SOURCES,
        job,
      ),
    ).toMatchObject({
      consecutiveAbsences: 1,
    });
  });

  it('evidence on a source disabled all along, missing, third-party, aggregator or unsupported never counts', () => {
    const set = [seen(0), notFound(1), notFound(2)];
    expect(derive(set).state).toBe('CLOSED');
    for (const standing of [
      source('official_ats', { enabled: false }),
      source('third_party'),
      source('official_ats', { provider: 'Aggregator ' }),
      source('official_ats', { provider: 'adzuna-feed' }),
    ])
      expect(derive(set, t(10), new Map(SOURCES).set('ats', standing)).state).toBe('DISCOVERED');
    const missing = new Map(SOURCES);
    missing.delete('ats');
    expect(derive(set, t(10), missing).state).toBe('DISCOVERED');
  });

  it('authoritative copies with no counting evidence: unconfirmed (POSSIBLY_STALE), never closed', () => {
    const job: DeriveJob = {
      ...JOB,
      copies: [
        { key: 'ats:1', sourceId: 'ats', board: A, authority: 'official_ats', provider: 'greenhouse' },
      ],
    };
    const disabled = new Map(SOURCES).set('ats', source('official_ats', { enabled: false }));
    const lc = derive([seen(0), notFound(1), notFound(2)], t(10), disabled, job);
    expect(lc).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 0 });
    expect(lc.history.at(-1)?.reason).toBe('no enabled authoritative source confirms the job');
    // Re-enabled, the same evidence counts again.
    expect(derive([seen(0), notFound(1), notFound(2)], t(10), SOURCES, job).state).toBe('CLOSED');
  });

  it('evidence read on another board than the copy was seen on is no evidence about the copy', () => {
    expect(derive([seen(0), absent(1, { board: B }), absent(2, { board: B }), notFound(3)])).toMatchObject({
      state: 'POSSIBLY_STALE',
      consecutiveAbsences: 0,
      consecutiveNotFound: 1,
    });
    // Without any sighting, a copy whose recorded board is unknown has no board: nothing counts.
    const unknown = {
      ...JOB,
      copies: JOB.copies.map((c) => (c.key === 'ats:1' ? { ...c, board: null } : c)),
    };
    expect(derive([notFound(1), notFound(2)], t(10), SOURCES, unknown).state).toBe('DISCOVERED');
  });

  it("HIGH-1 (re-verify #9): the board is the one of the copy's latest sighting AT OR BEFORE the evidence", () => {
    // Seen on A; absences read on B do not count; once seen on B, absences on B count — and the
    // copy's CURRENT recorded board is irrelevant to the past.
    const onB = { ...JOB, copies: JOB.copies.map((c) => (c.key === 'ats:1' ? { ...c, board: B } : c)) };
    const set = [
      seen(0),
      absent(1, { board: B }),
      absent(2, { board: B }),
      seen(5, { board: B }),
      absent(6, { board: B }),
    ];
    expect(derive(set, t(10), SOURCES, onB)).toMatchObject({ consecutiveAbsences: 1, absentSince: t(6) });
    expect(derive(set, t(10), SOURCES, JOB)).toMatchObject({ consecutiveAbsences: 1, absentSince: t(6) });
  });

  it('HIGH-1 (re-verify #9): a board change after a closure keeps the CLOSED history', () => {
    const closed = [seen(0), notFound(1), notFound(2)];
    const before = derive(closed, t(3));
    expect(before.history.map((h) => h.to)).toEqual(['VERIFIED_LIVE', 'POSSIBLY_STALE', 'CLOSED']);
    const onB = { ...JOB, copies: JOB.copies.map((c) => (c.key === 'ats:1' ? { ...c, board: B } : c)) };
    const after = derive([...closed, seen(9, { board: B })], t(10), SOURCES, onB);
    expect(after.history.map((h) => h.to)).toEqual(['VERIFIED_LIVE', 'POSSIBLY_STALE', 'CLOSED', 'REOPENED']);
    expect(after.history.slice(0, 3)).toEqual(before.history);
    // Without a new sighting, moving the copy's recorded board rewrites nothing either.
    expect(derive(closed, t(10), SOURCES, onB).history).toEqual(before.history);
  });

  it('boards compare by canonical identity (provider, API base, token), not raw URL (Low 5)', () => {
    const variant: CopyBoard = {
      ...A,
      endpointUrl: 'https://BOARDS.test/a/?content=true',
      provider: 'greenhouse',
    };
    expect(derive([seen(0), notFound(1, { board: variant }), notFound(2, { board: variant })]).state).toBe(
      'CLOSED',
    );
    const otherProvider: CopyBoard = { ...A, provider: 'lever' };
    const set = [seen(0, { board: { ...A, provider: 'greenhouse' } }), notFound(1, { board: otherProvider })];
    expect(derive(set).consecutiveNotFound).toBe(0);
  });

  it('third-party evidence neither resets a run nor blocks a closure', () => {
    const tp = seen(3, { copyKey: 'agg:1', sourceId: 'agg' });
    expect(derive([seen(0), absent(1), notFound(2), tp, absent(4)]).state).toBe('CLOSED');
  });

  it('a later positive reopens a closed job; a repost sighting reposts it; an earlier one never does', () => {
    const closed = [seen(0), notFound(1), notFound(2)];
    expect(derive([...closed, seen(3)]).state).toBe('REOPENED');
    expect(derive([...closed, live(3)]).state).toBe('REOPENED'); // RV-REOPEN
    // A repost: the FIRST sighting of a copy (in time order) while the job is closed.
    expect(derive([...closed, seen(3, { copyKey: 'ats2:1', sourceId: 'ats2' })]).state).toBe('REPOSTED');
    expect(derive([...closed, live(1.5)]).state).not.toBe('REOPENED');
    // A new copy of a job that is NOT closed is no repost (a syndicated copy).
    const syndicated = derive([seen(0), seen(1, { copyKey: 'ats2:1', sourceId: 'ats2' })]);
    expect(syndicated.state).toBe('VERIFIED_LIVE');
    expect(syndicated.history.map((h) => h.to)).not.toContain('REPOSTED');
    expect(derive([...closed, seen(3), seen(4)]).state).toBe('VERIFIED_LIVE');
  });

  it('a content change (a new content hash, in time order) is CHANGED until the next unchanged sighting', () => {
    const h = (at: number, hash: string) => seen(at, { contentHash: hash });
    expect(derive([h(0, 'a'), h(1, 'b')])).toMatchObject({ state: 'CHANGED', lastChangedAt: t(1) });
    expect(derive([h(0, 'a'), h(1, 'b'), h(2, 'b')]).state).toBe('VERIFIED_LIVE');
    // Low 2 (re-verify #9): an older sighting arriving late is compared in TIME order: 'a' then
    // 'a' then 'b' is one change at t2, whichever arrived last.
    expect(derive([h(2, 'b'), h(0, 'a'), h(1, 'a')])).toMatchObject({
      state: 'CHANGED',
      lastChangedAt: t(2),
    });
  });

  it('staleness decays to POSSIBLY_STALE and never closes; inconclusive is evidence of nothing', () => {
    expect(derive([seen(0)], t(71)).state).toBe('VERIFIED_LIVE');
    const stale = derive([seen(0)], t(1000));
    expect(stale.state).toBe('POSSIBLY_STALE');
    expect(stale.history.at(-1)).toMatchObject({
      at: t(72),
      reason: 'not confirmed within freshness window',
    });
    expect(derive([seen(0), ev({ kind: 'verification', outcome: 'inconclusive', at: t(1) })]).state).toBe(
      'VERIFIED_LIVE',
    );
  });

  it('a legacy baseline: its positive, its present copies and its closure — never its negatives', () => {
    const history = [
      { at: t(0), from: null, to: 'VERIFIED_LIVE' as const, reason: 'first seen on authoritative source' },
      { at: t(4), from: 'VERIFIED_LIVE' as const, to: 'POSSIBLY_STALE' as const, reason: 'absent' },
    ];
    const base = ev({
      kind: 'baseline',
      outcome: 'live',
      at: t(3),
      copyKey: null,
      sourceId: null,
      board: null,
      history,
    });
    const lc = derive([base], t(5));
    // MEDIUM-2 (re-verify #9): the baseline positive sets only lastVerifiedAt; the non-live legacy
    // state stays, and history gains no entry (least of all one dated before its last).
    expect(lc).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 0, lastVerifiedAt: t(3) });
    expect(lc.history).toEqual(history);
    // A newer positive makes it live, dated after the legacy history.
    const later = derive([base, seen(7)], t(8));
    expect(later.state).toBe('VERIFIED_LIVE');
    expect(later.history.at(-1)!.at.getTime()).toBeGreaterThanOrEqual(t(4).getTime());
    const closedHistory = [
      ...history,
      { at: t(5), from: 'POSSIBLY_STALE' as const, to: 'CLOSED' as const, reason: 'gone' },
    ];
    const closure = ev({
      kind: 'baseline',
      outcome: 'closed',
      at: t(5),
      copyKey: null,
      sourceId: null,
      board: null,
      reason: 'gone',
    });
    expect(derive([{ ...base, history: closedHistory }, closure])).toMatchObject({
      state: 'CLOSED',
      closedAt: t(5),
      closeReason: 'gone',
    });
    const copyBaseline = ev({ kind: 'baseline', outcome: 'present', at: t(2), board: A });
    expect(derive([{ ...base, history: closedHistory }, closure, copyBaseline, seen(6)]).state).toBe(
      'REOPENED',
    );
  });

  it('authoritative evidence time (the check gate) ignores third-party and aggregator copies', () => {
    expect(
      authoritativeEvidenceAt({
        lifecycle: { lastVerifiedAt: t(1) },
        sourceRefs: [
          { authority: 'official_ats', provider: 'greenhouse', lastSeenAt: t(3) },
          { authority: 'third_party', provider: 'aggregator', lastSeenAt: t(9) },
          { authority: 'official_ats', provider: ' Aggregator ', lastSeenAt: t(10) },
        ],
      }),
    ).toEqual(t(3));
  });
});

/** A seeded PRNG (mulberry32): reproducible shuffles and random evidence sets. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('derived job lifecycle: order independence (property)', () => {
  it('any permutation of the same evidence set gives the same lifecycle (500 random sets × 20 orders)', () => {
    const rand = rng(601136);
    const copies = ['ats:1', 'ats2:1', 'site:1', 'agg:1'];
    let differentFromArrival = 0;
    for (let set = 0; set < 500; set++) {
      const size = 1 + Math.floor(rand() * 14);
      const evidence: EvidenceItem[] = [];
      for (let i = 0; i < size; i++) {
        const copyKey = copies[Math.floor(rand() * copies.length)]!;
        const kind = rand() < 0.5 ? 'listing' : 'verification';
        const outcome =
          kind === 'listing'
            ? rand() < 0.5
              ? 'present'
              : 'absent'
            : (['live', 'not_found', 'inconclusive'] as const)[Math.floor(rand() * 3)]!;
        evidence.push({
          _id: `s${set}e${i}`,
          copyKey,
          sourceId: copyKey.split(':')[0]!,
          board: rand() < 0.85 ? A : B,
          // Coarse times, so ties between positives and negatives are frequent.
          at: t(Math.floor(rand() * 6)),
          kind,
          outcome,
          ...(kind === 'verification' && rand() < 0.3 ? { boardDerived: true } : {}),
          ...(outcome === 'present' && rand() < 0.2 ? { skipped: true } : {}),
          ...(outcome === 'present' ? { contentHash: rand() < 0.3 ? 'h1' : 'h0' } : {}),
        });
      }
      const now = t(Math.floor(rand() * 200));
      const expected = JSON.stringify(derive(evidence, now));
      for (let p = 0; p < 20; p++) {
        const order = shuffle(evidence, rand);
        const got = JSON.stringify(derive(order, now));
        expect(got).toBe(expected);
        if (got !== expected) differentFromArrival += 1;
      }
    }
    expect(differentFromArrival).toBe(0);
  });

  it('HIGH-A (re-verify #8): N1 at T1, L at T1.5, N2 at T2 — in every apply order — never closes', () => {
    const n1 = notFound(1);
    const l = live(1.5);
    const n2 = notFound(2);
    for (const order of [
      [n2, l, n1],
      [l, n1, n2],
      [n1, n2, l],
      [n2, n1, l],
      [n1, l, n2],
      [l, n2, n1],
    ])
      expect(derive([seen(0), ...order])).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 1 });
  });
});

/** A source with an enable/disable history ([hour, enabled] entries). */
const withHistory = (history: Array<[number, boolean]>) =>
  source('official_ats', {
    enabled: history[history.length - 1]![1],
    standingHistory: history.map(([h, enabled]) => ({ at: t(h), enabled })),
  });

describe('HIGH-1 (re-verify #9, DECISION_LOG 15c965b): standing is evaluated as of the evidence time', () => {
  const J2: DeriveJob = {
    ...JOB,
    copies: [
      { key: 'ats:1', sourceId: 'ats', board: A, authority: 'official_ats', provider: 'greenhouse' },
      { key: 'ats2:1', sourceId: 'ats2', board: A, authority: 'official_ats', provider: 'greenhouse' },
    ],
  };
  const one: DeriveJob = { ...J2, copies: [J2.copies[0]!] };

  it('(a) disabling the source that closed a job does not un-close it', () => {
    const closed = [seen(0), notFound(1), notFound(2)];
    const before = derive(closed, t(3), SOURCES, J2);
    expect(before.state).toBe('CLOSED');
    const off = new Map(SOURCES).set(
      'ats',
      withHistory([
        [-1, true],
        [50, false],
      ]),
    );
    const after = derive(closed, t(60), off, J2);
    expect(after).toMatchObject({ state: 'CLOSED', closedAt: before.closedAt });
    expect(after.history).toEqual(before.history);
  });

  it('(b) disabling the source that kept a job listed does not close it, least of all backdated', () => {
    const set = [
      seen(0),
      seen(0, { copyKey: 'ats2:1', sourceId: 'ats2' }),
      absent(1),
      absent(2),
      notFound(3),
    ];
    expect(derive(set, t(5), SOURCES, J2).state).not.toBe('CLOSED');
    const s2off = new Map(SOURCES).set(
      'ats2',
      withHistory([
        [-1, true],
        [400, false],
      ]),
    );
    const later = derive(set, t(500), s2off, J2);
    expect(later.state).not.toBe('CLOSED');
    expect(later.closedAt).toBeUndefined();
    expect(later.history.filter((h) => h.to === 'CLOSED')).toEqual([]);
  });

  it('(c) a not_found streak never spans a disabled interval; evidence while disabled never counts', () => {
    const gap = new Map(SOURCES).set(
      'ats',
      withHistory([
        [-1, true],
        [2, false],
        [2900, true],
      ]),
    );
    expect(derive([seen(0), notFound(1), notFound(3000)], t(3001), gap, one)).toMatchObject({
      state: 'POSSIBLY_STALE',
      consecutiveNotFound: 1,
    });
    // The disable at 2 ended the streak; the 404 at 100, while disabled, never counts.
    expect(derive([seen(0), notFound(1), notFound(100)], t(101), gap, one)).toMatchObject({
      consecutiveNotFound: 0,
    });
  });

  it('a disable ends an absence run as a positive would', () => {
    const gap = new Map(SOURCES).set(
      'ats',
      withHistory([
        [-1, true],
        [2.5, false],
        [2.6, true],
      ]),
    );
    expect(derive([seen(0), absent(1), absent(2), absent(3)], t(4), gap, one)).toMatchObject({
      consecutiveAbsences: 1,
      absentSince: t(3),
    });
  });
});

describe('MEDIUM-1 (re-verify #9): a not_found about one copy never closes a job another copy shows live', () => {
  it('two 404s on copy 1 while copy 2 was last seen present: POSSIBLY_STALE, not CLOSED', () => {
    const set = [seen(0, { copyKey: 'ats2:1', sourceId: 'ats2' }), seen(0.5), notFound(1), notFound(2)];
    expect(derive(set)).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 2 });
    // Once copy 2's latest evidence is negative too, the next not_found closes.
    expect(derive([...set, notFound(3, { copyKey: 'ats2:1', sourceId: 'ats2' })]).state).toBe('CLOSED');
  });
});

describe('MEDIUM-3 (re-verify #9): the fold can be checkpointed at any time', () => {
  it('folding up to a watermark and then the rest equals one fold (300 random sets, random splits)', () => {
    const rand = rng(91593);
    const copies = ['ats:1', 'ats2:1', 'site:1'];
    const sources = new Map(SOURCES).set(
      'ats2',
      withHistory([
        [-1, true],
        [2.5, false],
        [4, true],
      ]),
    );
    for (let set = 0; set < 300; set++) {
      const evidence: EvidenceItem[] = [];
      const size = 2 + Math.floor(rand() * 16);
      for (let i = 0; i < size; i++) {
        const copyKey = copies[Math.floor(rand() * copies.length)]!;
        const kind = rand() < 0.5 ? 'listing' : 'verification';
        const outcome =
          kind === 'listing'
            ? rand() < 0.5
              ? 'present'
              : 'absent'
            : (['live', 'not_found', 'inconclusive'] as const)[Math.floor(rand() * 3)]!;
        evidence.push({
          _id: `c${set}e${i}`,
          copyKey,
          sourceId: copyKey.split(':')[0]!,
          board: rand() < 0.85 ? A : B,
          at: t(Math.floor(rand() * 8)),
          kind,
          outcome,
          ...(outcome === 'present' ? { contentHash: rand() < 0.3 ? 'h1' : 'h0' } : {}),
        });
      }
      const whole = foldEvidence(initialFoldState(), evidence, sources, JOB);
      const split = t(Math.floor(rand() * 8));
      const first = foldEvidence(
        initialFoldState(),
        evidence.filter((e) => e.at <= split),
        sources,
        JOB,
      );
      const rest = evidence.filter((e) => !first.watermark || e.at > first.watermark);
      const resumed = foldEvidence(first, rest, sources, JOB);
      const end = (x: typeof whole) =>
        finalizeFold(foldEvidence(x, [], sources, JOB, undefined, t(9)), t(9), JOB);
      expect(JSON.stringify(end(resumed))).toBe(JSON.stringify(end(whole)));
      expect(JSON.stringify(end(whole))).toBe(JSON.stringify(deriveLifecycle(evidence, sources, t(9), JOB)));
    }
  });
});

describe('re-verify #10 (DECISION_LOG 9b0cb03): every close path needs no recent positive of another copy', () => {
  const J2: DeriveJob = {
    ...JOB,
    copies: [
      { key: 'ats:1', sourceId: 'ats', board: A },
      { key: 'ats2:1', sourceId: 'ats2', board: A },
    ],
  };
  const other = { copyKey: 'ats2:1', sourceId: 'ats2' };

  it("M2, the reviewer's repro: copy 2 verified live, copy 1 absent twice with a 404 — POSSIBLY_STALE, not CLOSED", () => {
    const set = [seen(0), live(1.5, other), absent(2), notFound(3), absent(4)];
    expect(derive(set, t(5), SOURCES, J2)).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 2 });
    // Without copy 2's positive, the same run closes.
    expect(derive([seen(0), absent(2), notFound(3), absent(4)], t(5), SOURCES, J2).state).toBe('CLOSED');
    // A positive older than the stale window no longer blocks the absence-driven close.
    // (Copy 2's live at 1.5 is 71.5 h old at the 404 — POSSIBLY_STALE — and 73.5 h old at the
    // second absence, which closes.)
    const late = [seen(0), live(1.5, other), absent(72), notFound(73), absent(75)];
    expect(derive(late, t(76), SOURCES, J2)).toMatchObject({ state: 'CLOSED', closedAt: t(75) });
  });

  it('M2: the not_found route uses the same stale window', () => {
    const set = [seen(0, other), seen(1), notFound(10), notFound(11)];
    expect(derive(set, t(12), SOURCES, J2).state).toBe('POSSIBLY_STALE');
    const old = [seen(0, other), seen(80), notFound(90), notFound(91)];
    expect(derive(old, t(92), SOURCES, J2)).toMatchObject({ state: 'CLOSED', closedAt: t(91) });
  });

  it('L6: a copy whose board changed keeps a positive nothing counts against — it stops blocking closure once stale', () => {
    // Copy 2 was last seen on board A; its source now lists board B, which is no evidence about it.
    const moved = [
      seen(0, other),
      seen(0),
      absent(50, { ...other, board: B }),
      absent(60, { ...other, board: B }),
    ];
    const within = derive([...moved, notFound(70), notFound(71)], t(72), SOURCES, J2);
    expect(within.state).toBe('POSSIBLY_STALE'); // copy 2's sighting at 0 is 70 h old: still recent
    const after = derive([...moved, notFound(80), notFound(81)], t(82), SOURCES, J2);
    expect(after).toMatchObject({ state: 'CLOSED', closedAt: t(81) });
  });
});

describe('re-verify #10 L1: a disable while CLOSED still makes the disabled copies unknown', () => {
  const J2: DeriveJob = {
    ...JOB,
    copies: [
      { key: 'ats:1', sourceId: 'ats', board: A },
      { key: 'ats2:1', sourceId: 'ats2', board: A },
    ],
  };
  it("the reviewer's sequence: closed, copy 2's source disabled, reopened — copy 2's old presence no longer keeps it listed", () => {
    const off = new Map(SOURCES).set(
      'ats2',
      withHistory([
        [-1, true],
        [90, false],
      ]),
    );
    const set = [
      seen(0),
      seen(0, { copyKey: 'ats2:1', sourceId: 'ats2' }),
      notFound(80),
      notFound(81), // closes: copy 2's sighting at 0 is past the stale window
      seen(100), // reopens (after the disable at 90, while CLOSED)
      absent(101),
      notFound(101.5),
      absent(102),
    ];
    const d = derive(set, t(103), off, J2);
    expect(d.history.map((h) => h.to)).toEqual([
      'VERIFIED_LIVE',
      'POSSIBLY_STALE',
      'CLOSED',
      'REOPENED',
      'POSSIBLY_STALE',
      'CLOSED',
    ]);
    expect(d).toMatchObject({ state: 'CLOSED', closedAt: t(101.5) });
    // The closure itself stands through the disable: nothing about it changes.
    expect(derive(set.slice(0, 4), t(95), off, J2)).toMatchObject({ state: 'CLOSED', closedAt: t(81) });
  });
});

describe('re-verify #10 L5: a first sighting is read from the evidence only', () => {
  it("a copy's firstSeenAt does not decide a repost; a legacy seen marker does", () => {
    const J: DeriveJob = {
      ...JOB,
      copies: JOB.copies.map((c) => ({ ...c, firstSeenAt: t(-100) })) as DeriveJob['copies'],
    };
    const closed = [seen(0), notFound(1), notFound(2)];
    const later = seen(3, { copyKey: 'ats2:1', sourceId: 'ats2' });
    expect(derive([...closed, later], t(4), SOURCES, J).state).toBe('REPOSTED');
    const marker = ev({
      kind: 'baseline',
      outcome: 'inconclusive',
      copyKey: 'ats2:1',
      sourceId: 'ats2',
      board: null,
      at: t(-100),
    });
    expect(derive([...closed, marker, later], t(4), SOURCES, J).state).toBe('REOPENED');
    // The marker says nothing else: no positive, no state.
    expect(derive([marker], t(4), SOURCES, J).state).toBe('DISCOVERED');
  });
});

describe('re-verify #11 M-B: a stale present on an incomplete-listing source never blocks absence closure', () => {
  it('Ashby plus a careers copy: a year of complete Ashby absences and board-derived not_founds closes, as without the careers copy', () => {
    const sources = new Map(SOURCES).set('ashby', source('official_ats', { provider: 'ashby' }));
    const ashby = { copyKey: 'ashby:1', sourceId: 'ashby' };
    const site = { copyKey: 'site:1', sourceId: 'site' };
    const withSite: DeriveJob = {
      ...JOB,
      copies: [
        { key: 'ashby:1', sourceId: 'ashby', board: A },
        { key: 'site:1', sourceId: 'site', board: A },
      ],
    };
    const alone: DeriveJob = { ...withSite, copies: [withSite.copies[0]!] };
    const year: EvidenceItem[] = [];
    for (let w = 1; w <= 52; w++)
      year.push(absent(168 * w, ashby), notFound(168 * w + 1, { ...ashby, boardDerived: true }));
    const base = derive([seen(0, ashby), ...year], t(168 * 53), sources, alone);
    expect(base.state).toBe('CLOSED');
    const both = derive([seen(0, ashby), seen(0, site), ...year], t(168 * 53), sources, withSite);
    expect(both).toMatchObject({ state: 'CLOSED', closedAt: base.closedAt, closeReason: base.closeReason });
    // A recent careers sighting still keeps the job listed (no absence counts while it is fresh).
    const fresh = derive([seen(0, ashby), seen(160, site), absent(168, ashby)], t(169), sources, withSite);
    expect(fresh).toMatchObject({ consecutiveAbsences: 0 });
    expect(fresh.state).not.toBe('CLOSED');
  });
});

describe("re-verify #11 L-2: a first sighting is the copy's earliest, counted or not", () => {
  it("the reviewer's gh2:1: sighted while its source was disabled, then again after a closure — REOPENED, not REPOSTED", () => {
    const J2: DeriveJob = {
      ...JOB,
      copies: [
        { key: 'ats:1', sourceId: 'ats', board: A },
        { key: 'ats2:1', sourceId: 'ats2', board: A },
      ],
    };
    const gap = new Map(SOURCES).set(
      'ats2',
      withHistory([
        [-1, true],
        [0.5, false],
        [1.5, true],
      ]),
    );
    const other = { copyKey: 'ats2:1', sourceId: 'ats2' };
    const set = [seen(0), seen(1, other), notFound(2), notFound(3), seen(4, other)];
    expect(derive(set, t(5), gap, J2).state).toBe('REOPENED');
    // Without the earlier (uncounted) sighting, the same later sighting is a repost.
    expect(derive([seen(0), notFound(2), notFound(3), seen(4, other)], t(5), gap, J2).state).toBe('REPOSTED');
  });
});
