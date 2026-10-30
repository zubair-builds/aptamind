import { describe, expect, it } from 'vitest';
import { ADAPTERS } from './index';
import { entryExternalId, finishListing, MAX_MALFORMED_RATIO } from './shared';
import type { AdapterListing } from './types';

/** `valid` well-formed entries plus the given raw entries, in each provider's listing shape. */
const board = {
  greenhouse: (valid: number, extra: unknown[] = []) => ({
    jobs: [...Array.from({ length: valid }, (_, i) => ({ id: 1000 + i, title: `Job ${i}` })), ...extra],
  }),
  lever: (valid: number, extra: unknown[] = []) => [
    ...Array.from({ length: valid }, (_, i) => ({ id: `p-${i}`, text: `Job ${i}` })),
    ...extra,
  ],
  ashby: (valid: number, extra: unknown[] = []) => ({
    jobs: [...Array.from({ length: valid }, (_, i) => ({ id: `a-${i}`, title: `Job ${i}` })), ...extra],
  }),
};

describe('M6.1 listing completeness (every ATS adapter)', () => {
  const malformed = {
    greenhouse: { id: 42, title: null },
    lever: { id: 'p-42', text: null },
    ashby: { id: 'a-42', title: '' },
  } as const;
  const expectedId = { greenhouse: '42', lever: 'p-42', ashby: 'a-42' } as const;

  describe.each(['greenhouse', 'lever', 'ashby'] as const)('%s', (provider) => {
    const adapter = ADAPTERS[provider];
    const ctx = { boardToken: 'acme' };

    it('keeps a malformed entry with an id as skipped (seen) and stays complete at ≤ 10 %', () => {
      const listing = adapter.parseListing(board[provider](9, [malformed[provider]]), ctx);
      expect(listing.complete).toBe(true);
      expect(listing.jobs).toHaveLength(9);
      expect(listing.skipped).toEqual([
        expect.objectContaining({ externalId: expectedId[provider], kind: 'malformed' }),
      ]);
      expect(listing.warnings).toHaveLength(1);
    });

    it('is incomplete when more than 10 % of entries are malformed', () => {
      const listing = adapter.parseListing(board[provider](8, [malformed[provider]]), ctx);
      expect(1 / 9).toBeGreaterThan(MAX_MALFORMED_RATIO);
      expect(listing.complete).toBe(false);
      expect(listing.warnings.at(-1)).toMatch(/1\/9 entries malformed/);
    });

    it('is incomplete when a malformed entry has no usable id (it could be any job)', () => {
      const anonymous = { ...malformed[provider], id: null };
      const listing = adapter.parseListing(board[provider](30, [anonymous]), ctx);
      expect(listing.skipped).toEqual([expect.objectContaining({ externalId: null, kind: 'malformed' })]);
      expect(listing.complete).toBe(false);
      expect(listing.warnings.at(-1)).toMatch(/no usable id/);
    });

    it('a clean board is complete with nothing skipped', () => {
      const listing = adapter.parseListing(board[provider](3), ctx);
      expect(listing).toMatchObject({ complete: true, skipped: [], warnings: [] });
    });
  });

  it('Ashby: unlisted entries are skipped (seen) without a warning and do not count as malformed', () => {
    const unlisted = Array.from({ length: 5 }, (_, i) => ({
      id: `u-${i}`,
      title: `Hidden ${i}`,
      isListed: false,
    }));
    const listing = ADAPTERS.ashby.parseListing(board.ashby(5, unlisted), { boardToken: 'acme' });
    expect(listing.complete).toBe(true);
    expect(listing.warnings).toEqual([]);
    expect(listing.skipped.map((s) => [s.externalId, s.kind])).toEqual(
      unlisted.map((u) => [u.id, 'unlisted']),
    );
  });

  it('Greenhouse: an incomplete listing (meta.total mismatch) stays incomplete', () => {
    const raw = { ...board.greenhouse(3), meta: { total: 4 } };
    expect(ADAPTERS.greenhouse.parseListing(raw, { boardToken: 'acme' }).complete).toBe(false);
  });
});

describe('entryExternalId', () => {
  it.each([
    [{ id: 4012345001 }, '4012345001'],
    [{ id: 'abc' }, 'abc'],
    [{ id: '  ' }, null],
    [{ id: '' }, null],
    [{ id: null }, null],
    [{ id: Number.NaN }, null],
    [{ id: { nested: 1 } }, null],
    [{}, null],
    ['not an object', null],
    [null, null],
  ])('%j → %s', (raw, expected) => {
    expect(entryExternalId(raw)).toBe(expected);
  });
});

describe('finishListing', () => {
  const listing = (over: Partial<AdapterListing>): AdapterListing => ({
    jobs: [],
    skipped: [],
    complete: true,
    warnings: [],
    ...over,
  });

  it('never turns an incomplete listing complete', () => {
    expect(finishListing(listing({ complete: false })).complete).toBe(false);
  });

  it('ignores unlisted entries for the malformed ratio', () => {
    const skipped = Array.from({ length: 10 }, (_, i) => ({
      externalId: `u${i}`,
      kind: 'unlisted' as const,
      locator: `/${i}`,
      reason: 'unlisted',
    }));
    expect(finishListing(listing({ skipped })).complete).toBe(true);
  });

  it('A-L4: the 10 % denominator is listed + malformed; unlisted entries do not dilute it', () => {
    const entry = (i: number, kind: 'unlisted' | 'malformed') => ({
      externalId: `${kind}${i}`,
      kind,
      locator: `/${kind}/${i}`,
      reason: kind,
    });
    const jobs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ locator: `/jobs/${i}` }) as AdapterListing['jobs'][number]);
    const unlisted = Array.from({ length: 100 }, (_, i) => entry(i, 'unlisted'));
    // 1 malformed of 8 listed + 1 malformed = 11 % (> 10 %): incomplete, however many are unlisted.
    expect(
      finishListing(listing({ jobs: jobs(8), skipped: [entry(0, 'malformed'), ...unlisted] })).complete,
    ).toBe(false);
    // 1 of 9 + 1 = 10 %: complete.
    expect(
      finishListing(listing({ jobs: jobs(9), skipped: [entry(0, 'malformed'), ...unlisted] })).complete,
    ).toBe(true);
  });
});
