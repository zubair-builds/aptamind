import { describe, expect, it } from 'vitest';
import {
  assessListing,
  boardDerivedNotFoundGate,
  isListingShrink,
  type ListingAssessmentInput,
} from './listing-policy';

const at = new Date('2026-09-29T12:00:00Z');
const base: ListingAssessmentInput = {
  itemExternalIds: ['1', '2'],
  skipped: [],
  complete: true,
  fetchedAt: at,
  fanout: { total: 2, failed: 0 },
  maxFailureRatio: 0.1,
};

describe('assessListing', () => {
  it('applies a complete listing; seen = mapped items', () => {
    expect(assessListing(base)).toEqual({
      apply: true,
      code: null,
      reason: null,
      seen: new Set(['1', '2']),
      shrink: null,
      baselineAfter: 2,
    });
  });

  it('M6.1: skipped entries with an id are seen, never absent; anonymous ones add nothing', () => {
    const r = assessListing({
      ...base,
      skipped: [{ externalId: '3' }, { externalId: null }],
    });
    expect(r.apply).toBe(true);
    expect([...r.seen].sort()).toEqual(['1', '2', '3']);
  });

  it('holds a listing already applied (reprocessing / replay)', () => {
    expect(assessListing({ ...base, lastListingAppliedAt: at })).toMatchObject({
      apply: false,
      code: 'already_applied',
    });
  });

  it('holds an incomplete listing', () => {
    expect(assessListing({ ...base, complete: false })).toMatchObject({ apply: false, code: 'incomplete' });
  });

  it('holds when too many items failed to process', () => {
    expect(assessListing({ ...base, fanout: { total: 10, failed: 2 } })).toMatchObject({
      apply: false,
      code: 'item_failures',
    });
  });
});

describe('M6.2 shrink guard', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => String(i));
  const listing = (n: number, over: Partial<ListingAssessmentInput> = {}) =>
    assessListing({ ...base, itemExternalIds: ids(n), fanout: { total: n, failed: 0 }, ...over });

  it.each([
    [200, 5, true],
    [200, 99, true],
    [200, 100, false], // exactly half is not below half
    [20, 9, true], // drop 11
    [19, 9, true], // below half (9.5), drop exactly 10
    [19, 10, false], // not below half
    [12, 5, false], // below half but a drop of 7 is ordinary churn
    [3, 0, false], // not a shrink: a small board that empties is the L2 one-run hold, not a review
    [9, 0, false],
    [10, 0, true], // empty after a board of ≥ 10
    [0, 0, false],
    [null, 0, false], // no baseline yet
  ])('baseline %s → %s entries: shrink=%s', (baseline, count, expected) => {
    expect(isListingShrink(baseline, count)).toBe(expected);
  });

  it('holds a shrink and keeps the baseline (baselineAfter null)', () => {
    const r = listing(5, { baselineCount: 200 });
    expect(r).toMatchObject({
      apply: false,
      code: 'shrink',
      baselineAfter: null,
      shrink: { baselineCount: 200, count: 5, confirmed: false },
    });
    expect(r.reason).toMatch(/shrank from 200 to 5/);
  });

  it('holds an empty listing after a board of ≥ 10 (review); a small board that empties is held once (L2)', () => {
    expect(listing(0, { baselineCount: 12 })).toMatchObject({ apply: false, code: 'shrink' });
    expect(listing(0, { baselineCount: 3 })).toMatchObject({ apply: false, code: 'small_board_empty' });
  });

  it('skipped entries count toward the size (a board of malformed-but-present entries is not a shrink)', () => {
    const skipped = ids(195).map((i) => ({ externalId: `s${i}` }));
    expect(listing(5, { baselineCount: 200, skipped }).apply).toBe(true);
  });

  it('an operator-confirmed size is the effective baseline', () => {
    expect(listing(5, { baselineCount: 200, confirmedCount: 5 })).toMatchObject({
      apply: true,
      baselineAfter: 5,
      shrink: { baselineCount: 200, count: 5, confirmed: true },
    });
    expect(listing(6, { baselineCount: 200, confirmedCount: 5 }).apply).toBe(true);
    // After a confirmed small size, emptying is a small-board case: held for one run (L2).
    expect(listing(0, { baselineCount: 200, confirmedCount: 5 }).code).toBe('small_board_empty');
    // A further collapse from a confirmed size of ≥ 10 is held again.
    expect(listing(0, { baselineCount: 200, confirmedCount: 40 })).toMatchObject({
      apply: false,
      code: 'shrink',
    });
    expect(listing(3, { baselineCount: 100, confirmedCount: 40 })).toMatchObject({ apply: false });
  });

  it('checks completeness and replays before the shrink (they already hold)', () => {
    expect(listing(5, { baselineCount: 200, complete: false }).code).toBe('incomplete');
    expect(listing(5, { baselineCount: 200, lastListingAppliedAt: at }).code).toBe('already_applied');
  });
});

describe('ruling L2: a small board that empties is held for one run', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
  const base = {
    skipped: [],
    complete: true,
    fanout: { total: 0, failed: 0 },
    maxFailureRatio: 0.1,
    baselineCount: 3,
  };
  it('holds the first empty listing (no review code), releases the next later one', () => {
    const first = assessListing({ ...base, itemExternalIds: [], fetchedAt: at(1) });
    expect(first).toMatchObject({ apply: false, code: 'small_board_empty' });
    // A replay of the held listing is held again; the next listing is applied.
    expect(
      assessListing({ ...base, itemExternalIds: [], fetchedAt: at(1), smallBoardHold: { at: at(1) } }).code,
    ).toBe('small_board_empty');
    expect(
      assessListing({ ...base, itemExternalIds: [], fetchedAt: at(2), smallBoardHold: { at: at(1) } }),
    ).toMatchObject({ apply: true, baselineAfter: 0 });
  });
  it('does not touch non-empty small listings or boards of ≥ 10', () => {
    expect(assessListing({ ...base, itemExternalIds: ['a'], fetchedAt: at(1) }).apply).toBe(true);
    expect(assessListing({ ...base, baselineCount: 12, itemExternalIds: [], fetchedAt: at(1) }).code).toBe(
      'shrink',
    );
  });
  it('an operator-confirmed small size that empties is a small-board case too', () => {
    expect(
      assessListing({
        ...base,
        baselineCount: 200,
        confirmedCount: 5,
        itemExternalIds: [],
        fetchedAt: at(1),
      }),
    ).toMatchObject({ apply: false, code: 'small_board_empty', shrink: { baselineCount: 5 } });
  });
});

describe('DECISION_LOG b7f1a76: a board-derived not_found only corroborates a job-level absence run', () => {
  const t = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
  const run = (over: Partial<Parameters<typeof boardDerivedNotFoundGate>[0]['run']> = {}) => ({
    consecutiveAbsences: 2,
    absentSince: t(10),
    lastAuthoritativeSeenAt: t(5),
    lastVerifiedAt: t(5),
    ...over,
  });
  const gate = (over: Partial<Parameters<typeof boardDerivedNotFoundGate>[0]> = {}) =>
    boardDerivedNotFoundGate({
      boardEntries: 0,
      baselineCount: 0,
      listingHeld: false,
      run: run(),
      sourcePositiveAt: t(5),
      ...over,
    }).counts;

  it('counts for a job absent twice at the job level, with no positive evidence since and no hold', () => {
    expect(gate()).toBe(true);
    expect(gate({ boardEntries: 99, baselineCount: 100 })).toBe(true);
  });
  it.each([
    ['one absence', { run: run({ consecutiveAbsences: 1 }) }],
    ['no absence run', { run: run({ consecutiveAbsences: 0, absentSince: null }) }],
    ['an authoritative sighting since the first absence', { run: run({ lastAuthoritativeSeenAt: t(11) }) }],
    ['an authoritative sighting at the first absence', { run: run({ lastAuthoritativeSeenAt: t(10) }) }],
    ['a live verification at the first absence', { run: run({ lastVerifiedAt: t(10) }) }],
    ['an empty board with a sighting on the source at the first absence', { sourcePositiveAt: t(10) }],
    ['a live verification since the first absence', { run: run({ lastVerifiedAt: t(12) }) }],
    ['a hold in force', { listingHeld: true }],
    ['an empty board with a sighting on the source since', { sourcePositiveAt: t(11) }],
    ['a truncated non-empty board', { boardEntries: 3, baselineCount: 100 }],
  ])('%s → inconclusive', (_label, over) => {
    expect(gate(over as never)).toBe(false);
  });
  it('a non-empty board ignores source-level evidence (only the shrink guard applies)', () => {
    expect(gate({ boardEntries: 5, baselineCount: 5, sourcePositiveAt: t(99) })).toBe(true);
  });
});
