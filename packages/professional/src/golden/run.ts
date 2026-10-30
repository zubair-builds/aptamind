/**
 * Professional golden evaluation CLI: `pnpm --filter @aptamind/professional eval:golden` (also
 * run by the root `pnpm eval:golden`). Exits non-zero on any failure.
 */
import { evaluateAllGolden } from './evaluators';

const results = evaluateAllGolden();
let failed = 0;
for (const r of results) {
  console.log(`\n${r.suite}: ${r.passed}/${r.passed + r.failed} passed`);
  for (const c of r.cases) {
    console.log(`  ${c.passed ? '✓' : '✗'} ${c.id}`);
    for (const f of c.failures) console.log(`      ${f}`);
  }
  failed += r.failed;
}
const total = results.reduce((a, r) => a + r.passed + r.failed, 0);
console.log(`\nProfessional golden evaluation: ${total - failed}/${total} cases passed`);
process.exit(failed ? 1 : 0);
