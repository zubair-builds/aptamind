import { describe, expect, it } from 'vitest';
import { BASES, BASIS_RANK, basisOf, compareBasis } from './basis';
import { partialDateSchema, presentSchema, timezoneWindowSchema, urlSchema } from './values';

describe('basis precedence (PL-1)', () => {
  it('orders confirmed > stated > extracted > inferred', () => {
    expect([...BASES].sort((a, b) => compareBasis(b, a))).toEqual([
      'confirmed',
      'stated',
      'extracted',
      'inferred',
    ]);
    expect(BASIS_RANK).toEqual({ confirmed: 4, stated: 3, extracted: 2, inferred: 1 });
  });

  it('confirmed iff state is CONFIRMED; otherwise the best current mode; no support is null', () => {
    expect(basisOf('CONFIRMED', [])).toBe('confirmed');
    expect(basisOf('CONFIRMED', ['inferred'])).toBe('confirmed');
    expect(basisOf('PROPOSED', ['inferred', 'extracted'])).toBe('extracted');
    expect(basisOf('CONFLICTED', ['extracted', 'stated', 'inferred'])).toBe('stated');
    expect(basisOf('PROPOSED', [])).toBeNull();
  });

  it('a formerly confirmed assertion (superseded, revoked, rejected) is not confirmed', () => {
    for (const state of ['SUPERSEDED', 'REJECTED', 'WITHDRAWN', 'PROPOSED', 'CONFLICTED'] as const) {
      expect(basisOf(state, ['stated'])).toBe('stated');
      expect(basisOf(state, [])).toBeNull();
    }
  });
});

describe('value primitives', () => {
  it('partial dates carry explicit precision', () => {
    expect(partialDateSchema.safeParse({ year: 2019 }).success).toBe(true);
    expect(partialDateSchema.safeParse({ year: 2019, month: 3 }).success).toBe(true);
    expect(partialDateSchema.safeParse({ year: 2019, month: 0 }).success).toBe(false);
    expect(partialDateSchema.safeParse({ year: 2019, day: 3 }).success).toBe(false);
  });

  it('present requires a strict asOf date-time', () => {
    expect(presentSchema.safeParse({ open: true }).success).toBe(false);
    expect(presentSchema.safeParse({ open: true, asOf: '2024-01-01T00:00:00Z' }).success).toBe(true);
    expect(presentSchema.safeParse({ open: true, asOf: new Date('2024-01-01') }).success).toBe(true);
    for (const asOf of [null, true, 0, '2024-01-01', 'now', new Date('x')])
      expect(presentSchema.safeParse({ open: true, asOf }).success, String(asOf)).toBe(false);
  });

  it('URLs must be absolute http(s)', () => {
    expect(urlSchema.safeParse('https://example.org/x').success).toBe(true);
    expect(urlSchema.safeParse('http://example.org').success).toBe(true);
    for (const u of [
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'example.org',
      'ftp://x.org',
    ])
      expect(urlSchema.safeParse(u).success, u).toBe(false);
  });

  it('timezone windows are ordered', () => {
    expect(timezoneWindowSchema.safeParse({ minUtcOffset: -1, maxUtcOffset: 3 }).success).toBe(true);
    expect(timezoneWindowSchema.safeParse({ minUtcOffset: 3, maxUtcOffset: -1 }).success).toBe(false);
  });
});
