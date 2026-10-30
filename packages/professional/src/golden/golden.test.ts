import { describe, expect, it } from 'vitest';
import { evaluateAllGolden, GOLDEN_SUITES } from './evaluators';

describe('Professional golden suites (prof-rec-1)', () => {
  const results = evaluateAllGolden();

  it.each(GOLDEN_SUITES.map((s) => s.suite))('%s passes', (suite) => {
    const r = results.find((x) => x.suite === suite);
    expect(r).toBeDefined();
    expect(r?.cases.filter((c) => !c.passed)).toEqual([]);
    expect(r?.passed).toBeGreaterThanOrEqual(10);
  });

  it('case ids are unique across suites (mutation checks name them)', () => {
    const ids = results.flatMap((r) => r.cases.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
