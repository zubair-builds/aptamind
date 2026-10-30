import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CURSOR_MAX,
  cursorParam,
  idSemiJoin,
  SEMI_JOIN_MAX_IDS,
  csvParam,
  dateParam,
  decodeCursor,
  encodeCursor,
  keysetFilter,
  listPipeline,
  runList,
  mongoSort,
  sortFields,
  sortParam,
} from './list';

const OPTIONS = { name: [['n', 1]], seen: [['s', -1]] } as const;

describe('sort', () => {
  it('accepts whitelisted keys and their reverse; the _id tiebreak follows the last field', () => {
    const p = sortParam(['name', 'seen'], 'name');
    expect(p.parse(undefined)).toBe('name');
    expect(p.parse('-seen')).toBe('-seen');
    expect(p.safeParse('title').success).toBe(false);
    expect(mongoSort(sortFields(OPTIONS, '-name'))).toEqual({ n: -1, _id: -1 });
    expect(mongoSort(sortFields(OPTIONS, 'seen'))).toEqual({ s: -1, _id: -1 });
    expect(mongoSort(sortFields(OPTIONS, '-seen'))).toEqual({ s: 1, _id: 1 });
  });
});

describe('cursor', () => {
  it('round-trips dates, strings, numbers and nulls, bound to its sort', () => {
    const d = new Date('2026-09-29T10:00:00Z');
    const c = encodeCursor('-seen', [d, 'x', 3, null], 'job_1');
    expect(decodeCursor(c, '-seen', 4)).toEqual({ values: [d, 'x', 3, null], id: 'job_1' });
    expect(() => decodeCursor(c, 'seen', 4)).toThrow(/issued for sort -seen/);
    expect(() => decodeCursor(c, '-seen', 1)).toThrow(/Malformed/);
    expect(() => decodeCursor('%%%', '-seen', 1)).toThrow(/Malformed/);
    const tampered = Buffer.from(JSON.stringify({ s: 'seen', v: [{ $where: 'x' }], id: 'a' })).toString(
      'base64url',
    );
    expect(() => decodeCursor(tampered, 'seen', 1)).toThrow(/Malformed/);
    expect(() =>
      decodeCursor(Buffer.from('{"s":"seen","v":[1],"id":{"$gt":""}}').toString('base64url'), 'seen', 1),
    ).toThrow(/Malformed/);
  });

  it('a value too long for the bound yields a short reference cursor, which is accepted', () => {
    const long = 'n'.repeat(5000);
    const c = encodeCursor('name', [long], 'cmp_1');
    expect(c.length).toBeLessThanOrEqual(CURSOR_MAX);
    expect(cursorParam.safeParse(c).success).toBe(true);
    expect(decodeCursor(c, 'name', 1)).toEqual({ ref: true, id: 'cmp_1' });
    expect(() => decodeCursor(c, '-name', 1)).toThrow(/issued for sort name/);
    // The largest value that still fits stays self-contained.
    const selfContained = (n: number) =>
      !('ref' in decodeCursor(encodeCursor('name', ['n'.repeat(n)], 'cmp_1'), 'name', 1));
    let n = 1400;
    while (n < 2000 && selfContained(n + 1)) n++;
    expect(n).toBeLessThan(1500);
    expect(decodeCursor(encodeCursor('name', ['n'.repeat(n)], 'cmp_1'), 'name', 1)).toEqual({
      values: ['n'.repeat(n)],
      id: 'cmp_1',
    });
    // The pipeline needs the resolved position of a reference cursor.
    const plan = {
      match: {},
      sort: 'name',
      fields: sortFields(OPTIONS, 'name'),
      limit: 5,
      offset: 0,
      after: c,
    };
    expect(() => listPipeline(plan)).toThrow(/resolve a reference cursor/);
    expect(listPipeline(plan, { values: [long], id: 'cmp_1' })[0]).toEqual({
      $match: { $and: [{}, keysetFilter([['n', 1]], [long], 'cmp_1')] },
    });
  });

  it('refuses `after` together with `offset`', () => {
    const plan = {
      match: {},
      sort: 'name',
      fields: sortFields(OPTIONS, 'name'),
      limit: 5,
      count: 'none' as const,
    };
    expect(() => listPipeline({ ...plan, offset: 5, after: encodeCursor('name', ['a'], 'x') })).toThrow(
      /cannot be combined/,
    );
  });
});

describe('keysetFilter', () => {
  it('ascending: greater value, or equal value and greater _id', () => {
    expect(keysetFilter([['n', 1]], ['b'], 'id5')).toEqual({
      $or: [{ n: { $gt: 'b' } }, { n: 'b', _id: { $gt: 'id5' } }],
    });
  });
  it('descending: smaller value or null (nulls sort last), or equal value and smaller _id', () => {
    expect(keysetFilter([['s', -1]], [3], 'id5')).toEqual({
      $or: [{ $or: [{ s: { $lt: 3 } }, { s: null }] }, { s: 3, _id: { $lt: 'id5' } }],
    });
  });
  it('null positions: ascending continues into non-null values; descending stays within nulls', () => {
    expect(keysetFilter([['s', 1]], [null], 'id5')).toEqual({
      $or: [{ s: { $ne: null } }, { s: null, _id: { $gt: 'id5' } }],
    });
    expect(keysetFilter([['s', -1]], [null], 'id5')).toEqual({ $or: [{ s: null, _id: { $lt: 'id5' } }] });
  });
});

describe('parameters', () => {
  it('csv parameters accept a,b and repeated keys, de-duplicate and validate every value', () => {
    const p = csvParam(z.enum(['a', 'b', 'c']));
    expect(p.parse('a,b')).toEqual(['a', 'b']);
    expect(p.parse(['a', 'c,a'])).toEqual(['a', 'c']);
    expect(p.safeParse('a,x').success).toBe(false);
    expect(p.safeParse('').success).toBe(false);
  });
  it('dates accept a date or an ISO date-time with offset', () => {
    expect(dateParam.parse('2026-09-29')).toEqual(new Date('2026-09-29T00:00:00Z'));
    expect(dateParam.parse('2026-09-29T10:00:00+02:00')).toEqual(new Date('2026-09-29T08:00:00Z'));
    expect(dateParam.safeParse('yesterday').success).toBe(false);
  });
});

describe('semi-joins', () => {
  it('filter by an id set while it is small, else fall back to per-row stages', () => {
    const fallback = () => [{ $match: { x: 1 } }];
    expect(idSemiJoin(['a', 'b'], true, fallback)).toEqual({ match: { _id: { $in: ['a', 'b'] } } });
    expect(idSemiJoin(['a'], false, fallback)).toEqual({ match: { _id: { $nin: ['a'] } } });
    const many = Array.from({ length: SEMI_JOIN_MAX_IDS + 1 }, (_, i) => `id${i}`);
    expect(idSemiJoin(many, true, fallback)).toEqual({ stages: [{ $match: { x: 1 } }] });
  });

  it('refuse count=exact on the per-row fallback (it would look up every row), before any query', async () => {
    const col = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('no query expected');
        },
      },
    );
    const plan = {
      match: {},
      semiJoins: [{ $match: { x: 1 } }],
      sort: 'name',
      fields: sortFields(OPTIONS, 'name'),
      limit: 5,
      offset: 0,
    };
    await expect(runList(col as never, { ...plan, count: 'exact' })).rejects.toThrow(
      /count=exact is not available/,
    );
    await expect(runList(col as never, { ...plan, count: 'none' })).rejects.toThrow(/no query expected/);
  });
});
