import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jobInterpretationSchema } from '../contracts/employment';
import { evaluateInterpretationGolden, getPath, loadGoldenCases, matchExpectation } from './golden';
import { interpretJob } from './interpret';

const FIXTURES = fileURLToPath(new URL('../../fixtures/golden/jobs', import.meta.url));

const REQUIRED_CASES = [
  'remote-heading-us-only-body',
  'emea-only-remote',
  'timezone-only-remote',
  'worldwide-remote',
  'plain-remote-unclear-scope',
  'hybrid-3-days-london',
  'company-sponsor-capable-role-silent',
  'explicit-no-sponsorship',
  'explicit-yes-sponsorship',
  'salary-gbp-annual',
  'salary-usd-k-range',
  'salary-eur-european-separators',
  'salary-aed-monthly',
  'salary-usd-hourly',
  'salary-gbp-daily-contract',
  'salary-malformed',
  'salary-competitive-unknown',
  'salary-dollar-ambiguous-non-us',
  'requirements-critical-vs-preferred',
  'relocation-explicit',
  'unknown-stays-unknown',
];

describe('job interpretation golden fixtures', () => {
  const cases = loadGoldenCases(FIXTURES);

  it('includes every required Gate M3 case', () => {
    const ids = cases.map((c) => c.id);
    for (const id of REQUIRED_CASES) expect(ids).toContain(id);
  });

  it('passes every golden case', () => {
    const report = evaluateInterpretationGolden(FIXTURES);
    const failures = report.cases
      .filter((c) => !c.passed)
      .map((c) => `${c.id}:\n  ${c.failures.join('\n  ')}`);
    expect(failures).toEqual([]);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(cases.length);
  });

  it.each(cases.map((c) => [c.id, c] as const))('%s validates against jobInterpretationSchema', (_id, c) => {
    const out = interpretJob(c.input);
    expect(jobInterpretationSchema.safeParse(out).success).toBe(true);
    expect(JSON.stringify(interpretJob(c.input))).toBe(JSON.stringify(out));
  });
});

describe('golden expectation helpers', () => {
  const doc = {
    a: { b: [1, 2, 3], s: 'hello' },
    items: [
      { k: 'x', v: 1 },
      { k: 'y', v: 2 },
    ],
  };

  it('resolves paths, indices, lengths and selectors', () => {
    expect(getPath(doc, 'a.b.1')).toEqual({ found: true, value: 2 });
    expect(getPath(doc, 'a.b.length')).toEqual({ found: true, value: 3 });
    expect(getPath(doc, 'a.s.length')).toEqual({ found: true, value: 5 });
    expect(getPath(doc, 'items[k=y].v')).toEqual({ found: true, value: 2 });
    expect(getPath(doc, 'items[k=z].v').found).toBe(false);
    expect(getPath(doc, 'a.missing').found).toBe(false);
  });

  it('matches values and operators', () => {
    expect(matchExpectation({ found: true, value: [1, 2] }, [1, 2])).toBeNull();
    expect(matchExpectation({ found: true, value: [1, 2] }, [2, 1])).not.toBeNull();
    expect(matchExpectation({ found: true, value: 5 }, { $gte: 3 })).toBeNull();
    expect(matchExpectation({ found: true, value: 2 }, { $gte: 3 })).not.toBeNull();
    expect(matchExpectation({ found: true, value: ['a', 'b'] }, { $contains: 'b' })).toBeNull();
    expect(matchExpectation({ found: true, value: 'hello world' }, { $contains: 'world' })).toBeNull();
    expect(matchExpectation({ found: false, value: undefined }, { $exists: false })).toBeNull();
    expect(matchExpectation({ found: true, value: 'x' }, { $in: ['x', 'y'] })).toBeNull();
    expect(matchExpectation({ found: true, value: 'x' }, { $not: 'x' })).not.toBeNull();
    expect(matchExpectation({ found: false, value: undefined }, 1)).toMatch(/path not found/);
  });
});
