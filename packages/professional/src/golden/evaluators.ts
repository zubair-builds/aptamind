import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '@aptamind/contracts';
import { type ClaimType, parseClaimValue } from '../contracts/claims';
import { compareValues } from '../reconciliation/compatibility';
import { PROF_REC_1, type ReconciliationPolicy } from '../reconciliation/policy';
import { ItemSimulator, labelOf, type Step } from './simulator';

/**
 * Golden evaluators for the reconciliation policy (`prof-rec-1`):
 * - `reconciliation` — basis tiers, current-state chronology, compatible refinement, set
 *   membership and absence, support withdrawal (event sequences on one item);
 * - `confirmation-precedence` — confirmed truth vs automation, challenges, rejection/restatement,
 *   revival conditions (a)–(d) and the undated-document rule (event sequences);
 * - `conflict-detection` — compatible/incompatible value pairs per value type, including
 *   false-conflict traps and true conflicts.
 * Every sequence step is also checked to be a fixed point and to apply cleanly (write guards).
 */
export const PROFESSIONAL_GOLDEN_DIR = fileURLToPath(new URL('../../fixtures/golden', import.meta.url));

export interface GoldenCaseResult {
  id: string;
  passed: boolean;
  failures: string[];
}
export interface GoldenResult {
  suite: string;
  passed: number;
  failed: number;
  cases: GoldenCaseResult[];
}

type LabelOrLiteral = string | null | { literal: unknown };

interface Expect {
  canonical?: { value?: LabelOrLiteral; status?: string; basis?: string | null; assertion?: string };
  states?: Record<string, string>;
  /** Exact set of open requests: `type/reason:LABEL,LABEL` (labels sorted). */
  requests?: string[];
  /** Roles per open request (keyed as in `requests`): label → role. */
  roles?: Record<string, Record<string, string>>;
  /** Exact set of conflicts: `kind:LABEL,LABEL[@attr,attr]`. */
  conflicts?: string[];
  attributes?: Record<string, 'known' | 'conflicting'>;
  refinements?: string[];
  /** Canonical changes so far (profile versions this item caused). */
  versions?: number;
  confidence?: { level?: string; reasons?: string[]; reasonsExclude?: string[] };
  /** Only derived fields (confidence, evidence count) changed in this step. */
  derivedChanged?: boolean;
  /** Events emitted by this step that must be present: `LABEL:FROM>TO:reason`. */
  events?: string[];
  /** The prior supersession cause each revival event of this step carries. */
  revivalPrior?: Record<string, string>;
  /** The step changed nothing (no transitions, no canonical change, no request change). */
  noChange?: boolean;
  /** The step's reconciliation was skipped. */
  skipped?: string;
}

interface SequenceCase {
  id: string;
  claimType: ClaimType;
  values: Record<string, unknown>;
  aliases?: string[][];
  steps: (Step & { expect?: Expect })[];
  expect?: Expect;
}

interface PairCase {
  id: string;
  claimType: ClaimType;
  a: unknown;
  b: unknown;
  aliases?: string[][];
  /** Source chronology of each side (for chronology-aware rules such as education progress). */
  asOf?: { a: string; b: string };
  compatible: boolean;
  conflicting?: string[];
  morePrecise?: 'a' | 'b' | 'equal' | 'both';
}

type GoldenCase = SequenceCase | PairCase;

interface GoldenFile {
  description: string;
  cases: GoldenCase[];
}

export const GOLDEN_SUITES = [
  { suite: 'reconciliation', file: 'reconciliation.json' },
  { suite: 'confirmation-precedence', file: 'precedence.json' },
  { suite: 'conflict-detection', file: 'conflicts.json' },
] as const;

export function loadGolden(dir: string, file: string): GoldenFile {
  return JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as GoldenFile;
}

export function evaluateGoldenFile(
  suite: string,
  file: GoldenFile,
  policy: ReconciliationPolicy = PROF_REC_1,
): GoldenResult {
  const cases = file.cases.map((c) => {
    const failures: string[] = [];
    try {
      if ('steps' in c) evaluateSequence(c, policy, failures);
      else evaluatePair(c, policy, failures);
    } catch (err) {
      failures.push(`threw ${(err as Error).name}: ${(err as Error).message}`);
    }
    return { id: c.id, passed: failures.length === 0, failures };
  });
  const passed = cases.filter((c) => c.passed).length;
  return { suite, passed, failed: cases.length - passed, cases };
}

export function evaluateAllGolden(
  dir: string = PROFESSIONAL_GOLDEN_DIR,
  policy: ReconciliationPolicy = PROF_REC_1,
): GoldenResult[] {
  return GOLDEN_SUITES.map((s) => evaluateGoldenFile(s.suite, loadGolden(dir, s.file), policy));
}

function evaluatePair(c: PairCase, policy: ReconciliationPolicy, failures: string[]): void {
  const a = parseClaimValue(c.claimType, c.a);
  const b = parseClaimValue(c.claimType, c.b);
  const ctx = { rules: policy.compatibility, organizationAliases: c.aliases ?? [] };
  const ta = c.asOf ? new Date(c.asOf.a).getTime() : undefined;
  const tb = c.asOf ? new Date(c.asOf.b).getTime() : undefined;
  const r = compareValues(c.claimType, a, b, ctx, ta === undefined ? undefined : { a: ta, b: tb as number });
  const back = compareValues(
    c.claimType,
    b,
    a,
    ctx,
    ta === undefined ? undefined : { a: tb as number, b: ta },
  );
  if (r.compatible !== back.compatible || r.aMorePrecise !== back.bMorePrecise)
    failures.push('comparison is not symmetric');
  if (r.compatible !== c.compatible)
    failures.push(`compatible: expected ${c.compatible}, got ${r.compatible}`);
  if (c.conflicting && canonicalJson([...c.conflicting].sort()) !== canonicalJson(r.conflicting))
    failures.push(`conflicting: expected ${c.conflicting.join(',')}, got ${r.conflicting.join(',')}`);
  if (c.morePrecise) {
    const got =
      r.aMorePrecise && r.bMorePrecise ? 'both' : r.aMorePrecise ? 'a' : r.bMorePrecise ? 'b' : 'equal';
    if (got !== c.morePrecise) failures.push(`morePrecise: expected ${c.morePrecise}, got ${got}`);
  }
}

function evaluateSequence(c: SequenceCase, policy: ReconciliationPolicy, failures: string[]): void {
  const sim = new ItemSimulator(c.claimType, c.values, policy, c.aliases ?? []);
  c.steps.forEach((step, i) => {
    const { result, problems } = sim.apply(step);
    for (const p of problems) failures.push(`step ${i + 1}: ${p}`);
    if (step.expect) check(sim, result, step.expect, `step ${i + 1}`, failures);
  });
  if (c.expect) {
    const last = sim.reconcile();
    for (const p of last.problems) failures.push(`final: ${p}`);
    check(sim, last.result, c.expect, 'final', failures);
  }
}

function labels(ids: readonly string[]): string {
  return ids.map(labelOf).sort().join(',');
}

function sameSet(expected: readonly string[], got: readonly string[]): boolean {
  return canonicalJson([...expected].sort()) === canonicalJson([...got].sort());
}

function check(
  sim: ItemSimulator,
  result: ReturnType<ItemSimulator['reconcile']>['result'],
  e: Expect,
  at: string,
  failures: string[],
): void {
  const fail = (m: string) => failures.push(`${at}: ${m}`);
  const can = sim.canonical;
  if (e.canonical) {
    const x = e.canonical;
    if (x.status !== undefined && can?.status !== x.status)
      fail(`canonical.status ${can?.status} ≠ ${x.status}`);
    if (x.basis !== undefined && (can?.basis ?? null) !== x.basis)
      fail(`canonical.basis ${can?.basis} ≠ ${x.basis}`);
    if (x.assertion !== undefined && labelOf(can?.assertionId ?? '') !== x.assertion)
      fail(`canonical.assertion ${labelOf(can?.assertionId ?? '')} ≠ ${x.assertion}`);
    if (x.value !== undefined) {
      const want =
        x.value === null
          ? null
          : typeof x.value === 'string'
            ? sim.valueOf(x.value)
            : parseClaimValue(sim.claimType, x.value.literal);
      if (canonicalJson(can?.value ?? null) !== canonicalJson(want))
        fail(`canonical.value ${canonicalJson(can?.value ?? null)} ≠ ${canonicalJson(want)}`);
    }
  }
  for (const [label, state] of Object.entries(e.states ?? {}))
    if (sim.state(label) !== state) fail(`state of ${label}: ${sim.state(label)} ≠ ${state}`);
  if (e.requests) {
    const got = sim.requests().map((r) => `${r.type}/${r.params.reason}:${labels(r.assertionIds)}`);
    if (!sameSet(e.requests, got)) fail(`requests [${got.join(' | ')}] ≠ [${e.requests.join(' | ')}]`);
  }
  for (const [key, want] of Object.entries(e.roles ?? {})) {
    const q = sim.requests().find((r) => `${r.type}/${r.params.reason}:${labels(r.assertionIds)}` === key);
    const got = Object.fromEntries((q?.params.roles ?? []).map((x) => [labelOf(x.assertionId), x.role]));
    if (canonicalJson(got) !== canonicalJson(want))
      fail(`roles of ${key}: ${canonicalJson(got)} ≠ ${canonicalJson(want)}`);
  }
  if (e.conflicts) {
    const got = (can?.conflicts ?? []).map(
      (k) => `${k.kind}:${labels(k.assertionIds)}${k.attributes.length ? `@${k.attributes.join(',')}` : ''}`,
    );
    if (!sameSet(e.conflicts, got)) fail(`conflicts [${got.join(' | ')}] ≠ [${e.conflicts.join(' | ')}]`);
  }
  for (const [name, status] of Object.entries(e.attributes ?? {})) {
    const got = can?.attributes.find((a) => a.name === name)?.status;
    if (got !== status) fail(`attribute ${name}: ${got} ≠ ${status}`);
  }
  if (e.refinements && !sameSet(e.refinements, (can?.refinements ?? []).map(labelOf)))
    fail(`refinements [${(can?.refinements ?? []).map(labelOf).join(',')}] ≠ [${e.refinements.join(',')}]`);
  if (e.versions !== undefined && sim.canonicalChanges !== e.versions)
    fail(`versions ${sim.canonicalChanges} ≠ ${e.versions}`);
  if (e.confidence) {
    if (e.confidence.level && can?.confidence.level !== e.confidence.level)
      fail(`confidence.level ${can?.confidence.level} ≠ ${e.confidence.level}`);
    for (const r of e.confidence.reasons ?? [])
      if (!can?.confidence.reasons.includes(r)) fail(`confidence reason '${r}' missing`);
    for (const r of e.confidence.reasonsExclude ?? [])
      if (can?.confidence.reasons.includes(r)) fail(`confidence reason '${r}' present`);
  }
  const stepEvents = result.events
    .filter((ev) => ev.entity.kind === 'assertion')
    .map((ev) => `${labelOf(ev.entity.id)}:${ev.from}>${ev.to}:${ev.reason}`);
  for (const ev of e.events ?? [])
    if (!stepEvents.includes(ev)) fail(`event ${ev} missing (got ${stepEvents.join(' | ')})`);
  for (const [label, cause] of Object.entries(e.revivalPrior ?? {})) {
    const ev = result.events.find((x) => x.type === 'assertion.revived' && labelOf(x.entity.id) === label);
    if (!ev) fail(`no revival event for ${label}`);
    else if (ev.prior?.cause !== cause)
      fail(`revival of ${label} kept prior cause ${ev.prior?.cause} ≠ ${cause}`);
  }
  if (e.noChange) {
    const r = result;
    if (
      r.transitions.length ||
      r.supersessionUpdates.length ||
      r.changed ||
      r.derivedChanged ||
      r.requests.open.length ||
      r.requests.close.length
    )
      fail(
        `expected no change: ${r.transitions.length} transitions, changed=${r.changed}, ` +
          `open=${r.requests.open.length}, close=${r.requests.close.length}`,
      );
  }
  if (e.derivedChanged !== undefined && result.derivedChanged !== e.derivedChanged)
    fail(`derivedChanged ${result.derivedChanged} ≠ ${e.derivedChanged}`);
  if (e.skipped !== undefined && result.skipped !== e.skipped)
    fail(`skipped ${result.skipped} ≠ ${e.skipped}`);
}
