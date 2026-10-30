/**
 * Golden evaluation CLI: `pnpm eval:golden`.
 * Runs curated difficult cases for entity resolution, lifecycle, reconciliation and employment
 * intelligence (remote/location, sponsorship, salary, requirements). Exits non-zero on failure.
 */
import path from 'node:path';
import { MARKET_FIXTURES_DIR } from '../fixtures';
import { evaluateInterpretationGolden } from '../enrichment/golden';
import {
  evaluateAtsRegionsGolden,
  evaluateCompanyResolutionGolden,
  evaluateJobResolutionGolden,
  evaluateLifecycleGolden,
  evaluateReconciliationGolden,
  evaluateSponsorshipCorpus,
  type GoldenResult,
} from './evaluators';
import { evaluateRegisterGolden } from './registers';

const dir = path.join(MARKET_FIXTURES_DIR, 'golden');
const interp = evaluateInterpretationGolden(path.join(dir, 'jobs'));
const corpus = evaluateSponsorshipCorpus(dir);
const results: GoldenResult[] = [
  await evaluateCompanyResolutionGolden(dir),
  await evaluateJobResolutionGolden(dir),
  evaluateLifecycleGolden(dir),
  evaluateReconciliationGolden(dir),
  evaluateAtsRegionsGolden(dir),
  evaluateRegisterGolden(dir, MARKET_FIXTURES_DIR),
  { suite: 'employment-intelligence', ...interp },
  corpus,
];
let failed = 0;
for (const r of results) {
  console.log(`\n${r.suite}: ${r.passed}/${r.passed + r.failed} passed`);
  for (const c of r.cases) {
    console.log(`  ${c.passed ? '✓' : '✗'} ${c.id}`);
    for (const f of c.failures) console.log(`      ${f}`);
  }
  failed += r.failed;
}
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
const m = corpus.metrics;
console.log(
  `sponsorship corpus: posting-text verdicts ${m.verdicts}; wrong or unlabelled stated values ${m.wrongStated} (cases with a stated value gated: ${m.gatedStatedCases}); production path: verdicts ${m.production.verdicts}, wrong or unlabelled stated values ${m.production.wrongStated}; stated-value recall ${pct(m.stated.recall)} (${m.stated.extracted}/${m.stated.labelled}); realistic-editor recall ${pct(m.editors.recall)} (${m.editors.extracted}/${m.editors.labelled}); conflict cases ${m.conflictCases}; advisory flags ${m.advisory.present}/${m.advisory.expected}`,
);
const total = results.reduce((a, r) => a + r.passed + r.failed, 0);
console.log(`\nGolden evaluation: ${total - failed}/${total} cases passed`);
process.exit(failed ? 1 : 0);
