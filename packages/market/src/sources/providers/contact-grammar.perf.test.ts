import { describe, expect, it } from 'vitest';
import { mapDirectoryRow, parseDirectoryConfig } from './company-directory';
import { clearDetectorCaches, matchesAddressGrammar } from './contact-grammar';

/**
 * The detector is linear (PR #27 re-verification #11, MEDIUM-2): a label chain stops past 253
 * characters or 127 labels, and the tokeniser matches sticky patterns in place. Costs are measured
 * in units of REF — 500 typical rows mapped in the same process — so the bounds hold on any
 * machine. The 748b382 costs of the adversarial rows, measured the same way on the implementer's
 * machine (REF ≈ 148 ms): dots 0.63, hyph 1.59, dotw 0.38, xats 1.18 REF. Each must stay within 3× (generous against noisy runners; the ruling bar is 2×).
 */

const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    legalName: 'Legal',
    domain: 'Domain',
    website: 'Website',
    town: 'Town',
    country: 'Country',
    careersUrl: 'Careers',
  },
});
const fill = (pre: string, unit: string, n = 1995) => (pre + unit.repeat(2000)).slice(0, n);
/** Every cell a ~2k adversarial chain. */
const ADVERSARIAL: Record<string, { row: Record<string, string>; old: number }> = {
  dots: {
    old: 0.63,
    row: {
      Company: fill('Acme ', 'a.'),
      Legal: fill('x at ', 'a.'),
      Town: fill('x at ', 'a.'),
      Website: fill('https://acme.com/x-at-', 'a.'),
      Careers: fill('https://acme.com/?q=x+at+', 'a.'),
    },
  },
  hyph: {
    old: 1.59,
    row: {
      Company: fill('Acme ', 'a-'),
      Legal: fill('x at y.', 'a-'),
      Town: fill('x at y.', 'a-'),
      Website: fill('https://acme.com/x-at-y.', 'a-'),
      Careers: fill('https://acme.com/x-at-y.', 'a-'),
    },
  },
  dotw: {
    old: 0.38,
    row: {
      Company: fill('Acme ', 'a dot '),
      Legal: fill('x at ', 'a dot '),
      Town: fill('x at ', 'a dot '),
      Website: fill('https://acme.com/x-at-', 'a-dot-'),
      Careers: fill('https://acme.com/?q=x+at+', 'a+dot+'),
    },
  },
  xats: {
    old: 1.18,
    row: {
      Company: fill('Acme ', 'x at a.a '),
      Legal: fill('x at ', 'x at a.a '),
      Town: fill('', 'x at a.a '),
      Website: fill('https://acme.com/', 'x-at-a.a-'),
      Careers: fill('https://acme.com/', 'x-at-a.a-'),
    },
  },
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const timeOf = (f: () => unknown, runs = 5) =>
  median(
    Array.from({ length: runs }, () => {
      const t = performance.now();
      f();
      return performance.now() - t;
    }),
  );

describe('detector cost (linear, bounded)', () => {
  it('a label chain is linear: 8k characters cost about 4× 2k (quadratic would be 16×)', () => {
    const cell = (n: number) => `x at ${'a.'.repeat(n / 2)}`;
    matchesAddressGrammar(cell(2000));
    const small = timeOf(() => matchesAddressGrammar(cell(2000)), 7);
    const large = timeOf(() => matchesAddressGrammar(cell(8000)), 7);
    expect(large / Math.max(small, 0.05)).toBeLessThan(10);
  });

  it('adversarial 2k rows stay within 3× their 748b382 cost (in REF units)', { timeout: 120_000 }, () => {
    const typical = Array.from({ length: 500 }, (_, i) => ({
      Company: `Acme Widgets ${i} Ltd`,
      Legal: `Acme Widgets ${i} Limited`,
      Domain: `acme${i}.co.uk`,
      Website: `https://www.acme${i}.co.uk/about-us`,
      Town: 'Manchester',
      Country: 'GB',
      Careers: `https://careers.acme${i}.co.uk/jobs/senior-engineer-${i}?utm=x`,
    }));
    const ref = timeOf(() => typical.forEach((r, i) => mapDirectoryRow(config, r, i + 2)));
    const costs: Record<string, number> = {};
    for (const [name, { row }] of Object.entries(ADVERSARIAL)) {
      const full = { Country: 'GB', Domain: '', ...row };
      mapDirectoryRow(config, full, 2);
      costs[name] = timeOf(() => mapDirectoryRow(config, full, 2)) / ref;
    }
    console.log('detector cost (REF units)', JSON.stringify(costs), 'REF ms', ref.toFixed(1));
    for (const [name, { old }] of Object.entries(ADVERSARIAL))
      expect([name, costs[name]! <= 3 * old]).toEqual([name, true]);
  });

  it(
    'the adversarial corpus costs at most 50 ms per row, every cell filled (DECISION_LOG 6bff30e)',
    { timeout: 120_000 },
    () => {
      const cut = (v: string) => v.slice(0, 1995);
      const corpus: Record<string, string> = {
        rv13: cut(`j at ${'x'.repeat(70)}${' dot'.repeat(470)}`),
        rv13valid: cut(`j at x${' dot'.repeat(490)}`),
        dotsdots: cut(`j at x${' dot .'.repeat(330)}`),
        atat: cut('j at '.repeat(400)),
        mixed: cut('j at x dot y '.repeat(160)),
        chain: cut(`x at ${'a.'.repeat(1000)}`),
        hyphens: cut(`x at y.${'a-'.repeat(1000)}`),
        keywords: cut('at at dot dot '.repeat(150)),
        brackets: cut('j (a) x (dot) '.repeat(150)),
        punto: cut(`j arroba x${' punto'.repeat(330)}`),
        middots: cut(`j at x${' ·'.repeat(900)}`),
      };
      const costs: Record<string, number> = {};
      for (const [name, v] of Object.entries(corpus)) {
        const row = {
          Company: v,
          Legal: v,
          Town: v,
          Country: 'GB',
          Domain: v,
          Website: `https://acme.com/${v}`,
          Careers: `https://acme.com/${v}`,
        };
        // Cold-cache (DECISION_LOG 64d97b4): no warm-up run, the detector caches cleared before each
        // timed run; the fastest of 5 cold runs, robust against a noisy runner.
        costs[name] = Math.min(
          ...Array.from({ length: 5 }, () => {
            clearDetectorCaches();
            const t = performance.now();
            mapDirectoryRow(config, row, 2);
            return performance.now() - t;
          }),
        );
      }
      console.log('adversarial corpus ms/row', JSON.stringify(costs));
      for (const [name, ms] of Object.entries(costs)) expect([name, ms <= 50]).toEqual([name, true]);
    },
  );
});
