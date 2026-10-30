import type * as NodeUrl from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * PR #27 re-verification #15 (DECISION_LOG bd6ad44): every expensive primitive of the search is
 * memoised per label and charged to the cost budget. `domainToASCII` is observed through a spy.
 */
const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:url', async (importOriginal) => {
  const real = await importOriginal<typeof NodeUrl>();
  return {
    ...real,
    domainToASCII: (d: string) => {
      calls.n++;
      return real.domainToASCII(d);
    },
  };
});

const { tokenizeAddress, tokensMatchAddress } = await import('./contact-grammar');

const spent = (text: string) => {
  const budget = { left: 4000 };
  tokensMatchAddress(tokenizeAddress(text, 'separator'), budget);
  return 4000 - budget.left;
};

describe('grammar primitives: charged and memoised', () => {
  it('a non-ASCII label costs a parse on every check, cached or not (verdicts never depend on history)', () => {
    const ascii = spent('jane at bucher-zz dot shop-x');
    const unicode = spent('jane at bücher-zz dot shop-x');
    expect(unicode - ascii).toBeGreaterThanOrEqual(20);
    expect(spent('jane at bücher-zz dot shop-x')).toBe(unicode); // the same on a repeat
  });

  it('domainToASCII runs once per label: a repeated text encodes nothing again', () => {
    const text = `j at ${'ü'.repeat(20)}${'-ü'.repeat(40)} dot ${'é'.repeat(10)}${'-é'.repeat(30)}`;
    tokensMatchAddress(tokenizeAddress(text, 'separator'));
    const first = calls.n;
    expect(first).toBeGreaterThan(0);
    tokensMatchAddress(tokenizeAddress(text, 'separator'));
    expect(calls.n).toBe(first);
  });

  it('the bound is 3 × 63 code points: a label of 40 NFD é (80 code points, 40 after NFC) is encoded', () => {
    const before = calls.n;
    tokensMatchAddress(tokenizeAddress(`j at a dot ${'e\u0301'.repeat(40)}`, 'separator'));
    expect(calls.n).toBeGreaterThan(before);
  });

  it('the bound is 3 × 63, not 2 × 63: 43 decomposed Hangul syllables (129 code points, 50 encoded) are encoded', () => {
    const label = '각'.repeat(43).normalize('NFD');
    expect([...label]).toHaveLength(129);
    const before = calls.n;
    tokensMatchAddress(tokenizeAddress(`j at a dot ${label}`, 'separator'));
    expect(calls.n).toBeGreaterThan(before);
  });

  it('a label too long to encode to 63 characters is never encoded', () => {
    const before = calls.n;
    tokensMatchAddress(tokenizeAddress(`j at a dot ${'ж'.repeat(400)}`, 'separator'));
    expect(calls.n).toBe(before);
  });
});
