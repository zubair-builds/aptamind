import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXTERNAL_ID_NAMESPACES } from '../../companies/external-ids';
import { mapDirectoryRow, parseDirectoryConfig, RESERVED_ID_NAMESPACES } from './company-directory';
import { clearDetectorCaches } from './contact-grammar';

/**
 * Per-row cost (PR #27 re-verification #14, DECISION_LOG 29b6592): at most 100 ms per row. The bound
 * itself is structural (DECISION_LOG 47c0f5c: a fixed per-row work budget, `DIRECTORY_ROW_BUDGET`,
 * shared by every detector call; a spent budget fails the rest of the row closed); this wall-clock
 * test is a regression check on top of it, with the re-verification #18 climbed rows in the corpus.
 * The corpus (`directory-perf-corpus.json`) was hill-climbed offline against `mapDirectoryRow`
 * — random insert / delete / fill mutations over at-forms, dot-forms, brackets, hyphens,
 * escapes, entities, zero-width and combining characters, kept when slower — once per mapped
 * column (name, legal name, town, country, id, Domain, Website, Careers URL, every register-id
 * column) and once with the value in every column at once. Each shape is also run with its
 * zero-width variants (a zero-width space / word joiner after every character, cut to the cell
 * limit). Costs are cold-cache (no warm-up run, the detector caches cleared before each timed run;
 * the fastest of 3 cold runs). The re-verification
 * #15 shape (`point` words before 64 `ü` and 180 `-ü` cuts: an unbudgeted `domainToASCII` per cut)
 * is pinned too, as are the re-verification #16 Country shape (` .` and ~2 000 combining marks) and
 * the #17 NFKC-expansion shape (U+FDFA, ×18 under NFKC), and
 * a bounded random hill-climb runs in CI.
 */

// Every namespace a directory may map (the reserved ones belong to other providers).
const NS = Object.keys(EXTERNAL_ID_NAMESPACES).filter(
  (n) => !(RESERVED_ID_NAMESPACES as readonly string[]).includes(n),
);
const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    legalName: 'Legal',
    domain: 'Domain',
    website: 'Website',
    town: 'Town',
    country: 'Country',
    careersUrl: 'Careers',
    id: 'Id',
    registerIds: Object.fromEntries(NS.map((n) => [n, `R_${n}`])),
  },
});
const COLUMNS = [
  'Company',
  'Legal',
  'Domain',
  'Website',
  'Town',
  'Country',
  'Careers',
  'Id',
  ...NS.map((n) => `R_${n}`),
];
const PREFIX: Record<string, string> = { Website: 'https://acme.com/', Careers: 'https://acme.com/' };
const BASE: Record<string, string> = {
  ...Object.fromEntries(COLUMNS.map((c) => [c, ''])),
  Company: 'Acme Ltd',
  Country: 'GB',
  Id: 'r1',
};
const LIMIT = 2000;

/** `{ target: column | 'ALL', v: value }`, the climbed shapes. */
const CLIMBED = JSON.parse(
  readFileSync(new URL('./directory-perf-corpus.json', import.meta.url), 'utf8'),
) as Array<{
  target: string;
  v: string;
}>;
/** A register-id column added after the climb borrows the climbed register-id shapes. */
const CORPUS = [
  ...CLIMBED,
  ...NS.filter((n) => !CLIMBED.some((c) => c.target === `R_${n}`)).flatMap((n) =>
    CLIMBED.filter((c) => c.target.startsWith('R_')).map((c) => ({ target: `R_${n}`, v: c.v })),
  ),
];

const variants = (v: string) => [
  v,
  [...v].join('\u200b').slice(0, LIMIT),
  [...v].join('\u2060').slice(0, LIMIT),
  v.replace(/[ .]/g, (c) => `${c}\u200b`).slice(0, LIMIT),
];

function rowFor(target: string, v: string) {
  const row = { ...BASE };
  for (const c of target === 'ALL' ? COLUMNS : [target]) row[c] = ((PREFIX[c] ?? '') + v).slice(0, LIMIT);
  return row;
}

/** A 32-bit LCG (fixed seeds: the CI climb is reproducible). */
function lcg(seed: number) {
  let s = seed;
  return () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x80000000;
}
/** Mutation units: at-forms, dot-forms, brackets, hyphens, escapes, entities, invisible and combining characters, Unicode letters. */
// prettier-ignore
const UNITS = ['a', 'x', '1', '.', ' ', '-', '_', 'at', ' at ', 'dot', ' dot ', 'point ', '(a)', '(dot)', '@', '\u200b',
  '\u00ad', '\u2060', 'xn--', '%23', '%2E', '&num;', '&#64;', '/', '(', ')', '·', 'punto', 'co.uk', 'com', 'de', '\\',
  ':', '+', '[at]', '<a>', '"a"', ' . ', '.-', '-.', 'aa-', 'ü', '-ü', 'üü', '\u0301', '\ufe0f', 'ß', 'рф', '中国', '\ufdfa', '\ufdfa\ufdfa', '&amp;', '&#xD800;'];

/**
 * The cost of mapping one row, cold-cache (DECISION_LOG 64d97b4): no warm-up run, and the
 * detector's memoised primitives cleared before every timed run; the fastest of `runs` cold runs.
 */
function cost(target: string, v: string, runs: number) {
  const row = rowFor(target, v);
  let best = Infinity;
  for (let r = 0; r < runs; r++) {
    clearDetectorCaches();
    const t = performance.now();
    mapDirectoryRow(config, row, 2);
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

/** One bounded random hill-climb from `start`: insert, delete, fill and replace mutations, kept when slower. */
function climb(target: string, start: string, seed: number, iterations: number) {
  const rnd = lcg(seed);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
  let best = start.slice(0, LIMIT);
  let bestCost = cost(target, best, 1);
  for (let k = 0; k < iterations; k++) {
    let unit = '';
    for (let n = 1 + Math.floor(rnd() * 4); n > 0; n--) unit += pick(UNITS);
    const at = Math.floor(rnd() * best.length);
    const op = rnd();
    const next = (
      op < 0.3
        ? best.slice(0, at) + unit + best.slice(at)
        : op < 0.5
          ? best.slice(0, at) + best.slice(at + 1 + Math.floor(rnd() * 20))
          : op < 0.8
            ? best.slice(0, Math.floor(rnd() * Math.min(best.length, 40))) + unit.repeat(LIMIT)
            : best.slice(0, at) + unit + best.slice(at + 1 + Math.floor(rnd() * 20))
    ).slice(0, LIMIT);
    const c = cost(target, next, 1);
    if (c > bestCost) [best, bestCost] = [next, c];
  }
  return { v: best, ms: cost(target, best, 3) };
}

describe('per-row cost: a hill-climbed corpus over every mapped column (≤ 100 ms)', () => {
  it('the corpus covers every mapped column and all at once', () => {
    expect(new Set(CORPUS.map((c) => c.target))).toEqual(new Set([...COLUMNS, 'ALL']));
  });

  it('every shape and zero-width variant maps in at most 100 ms', { timeout: 300_000 }, () => {
    const costs: Array<[string, number]> = [];
    CORPUS.forEach(({ target, v }, i) =>
      variants(v).forEach((x, k) => {
        costs.push([`${i}:${target}:v${k}`, cost(target, x, 3)]);
      }),
    );
    const worst = [...costs].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log('per-row cost, worst 5 (ms)', JSON.stringify(worst.map(([n, ms]) => [n, +ms.toFixed(1)])));
    expect(costs.filter(([, ms]) => ms > 100)).toEqual([]);
  });

  // A bounded random hill-climb run in CI (DECISION_LOG bd6ad44): fixed seeds and a small number of
  // iterations per column, starting from the pinned shapes, so a regression that makes some nearby
  // shape slow is found without an offline search. `DIRECTORY_PERF_CLIMB` runs it longer.
  const ITERATIONS = Number(process.env.DIRECTORY_PERF_CLIMB ?? 12);
  it(
    `a bounded random hill-climb (${ITERATIONS} steps per column, fixed seeds) stays within 100 ms`,
    { timeout: 600_000 },
    () => {
      const results: Array<[string, number]> = [];
      [...new Set(CORPUS.map((c) => c.target))].forEach((target, i) => {
        const starts = CORPUS.filter((c) => c.target === target).map((c) => c.v);
        // The slowest pinned shape of the column, and the last one (the newest), from two seeds.
        const slowest = [...starts].sort((a, b) => cost(target, b, 1) - cost(target, a, 1))[0]!;
        for (const [start, seed] of [
          [slowest, 1409 + i],
          [starts.at(-1)!, 2027 + i],
        ] as const)
          results.push([target, climb(target, start, seed, ITERATIONS).ms]);
      });
      const worst = [...results].sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(
        'hill-climb per-row cost, worst 5 (ms)',
        JSON.stringify(worst.map(([n, ms]) => [n, +ms.toFixed(1)])),
      );
      expect(results.filter(([, ms]) => ms > 100)).toEqual([]);
    },
  );
});
