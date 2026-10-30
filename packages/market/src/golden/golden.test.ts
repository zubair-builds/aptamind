import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKET_FIXTURES_DIR } from '../fixtures';
import {
  evaluateAtsRegionsGolden,
  evaluateCompanyResolutionGolden,
  evaluateJobResolutionGolden,
  evaluateLifecycleGolden,
  evaluateReconciliationGolden,
  evaluateSponsorshipCorpus,
} from './evaluators';
import { evaluateRegisterGolden } from './registers';

const dir = path.join(MARKET_FIXTURES_DIR, 'golden');

describe('golden suites', () => {
  it.each([
    ['company resolution', () => evaluateCompanyResolutionGolden(dir)],
    ['job resolution', () => evaluateJobResolutionGolden(dir)],
    ['lifecycle', async () => evaluateLifecycleGolden(dir)],
    ['reconciliation', async () => evaluateReconciliationGolden(dir)],
    ['ats regions', async () => evaluateAtsRegionsGolden(dir)],
    ['register evidence', async () => evaluateRegisterGolden(dir, MARKET_FIXTURES_DIR)],
    ['sponsorship corpus (precision-first gate)', async () => evaluateSponsorshipCorpus(dir)],
  ])('%s', async (_name, run) => {
    const r = await run();
    expect(r.cases.filter((c) => !c.passed)).toEqual([]);
    expect(r.passed).toBeGreaterThan(3);
  });
});
