import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { jobInterpretationInputSchema, jobInterpretationSchema } from '../contracts/employment';
import type { EvidenceSpan, JobInterpretation, JobInterpretationInput } from '../contracts/employment';
import type { CompanyDoc } from '../companies/company.schema';
import type { JobObservationPayload } from '../contracts/observations';
import type { JobObservationDoc } from '../observations/schemas';
import type { JobDoc } from '../jobs/job.schema';
import { interpretationInput } from '../reconciliation/interpretation-input';
import { applyOverrides, JOB_OVERRIDE_PATHS } from '../reconciliation/overrides';
import { interpretJob } from './interpret';
import { locationFieldText, MAX_QUOTE_LENGTH } from './text';

/**
 * Golden regression evaluation for job interpretation (context doc §25.3, Gate M3).
 *
 * A fixture is `{ id, description, input, expect }` (or `stored` instead of `input`: a stored source
 * copy whose input is built as reconciliation builds it, see {@link StoredCopy}) where `expect` maps dotted paths to expected
 * values. Paths support array indices (`requirements.0.importance`), `.length`, and selectors
 * (`requirements[normalizedConcept=python].importance`). Expected values are deep-equal matches,
 * or operator objects: `{ "$gte": n }`, `{ "$lte": n }`, `{ "$contains": v }`, `{ "$exists": bool }`,
 * `{ "$in": [..] }`, `{ "$not": v }`. Every case is also checked against the interpretation
 * invariants (schema validity, evidence for every non-unknown field, verbatim quotes, determinism).
 */

export interface GoldenCase {
  id: string;
  description: string;
  input: JobInterpretationInput;
  expect: Record<string, unknown>;
  /**
   * Operator overrides (`job.overrides` values by field) applied to the interpreted facts as
   * reconciliation applies them (`applyOverrides`); expectations read the result under
   * `canonical.<field>` (e.g. `canonical.sponsorship.companyCapability`).
   */
  overrides?: Record<string, unknown>;
}

/**
 * A case may start from a stored source copy instead of a ready input: the observation payload
 * and the company state reconciliation reads. Its input is then built by `interpretationInput`,
 * the one constructor reconciliation and `market.interpret_job` share (M6.4).
 */
export interface StoredCopy {
  payload: Pick<JobObservationPayload, 'title' | 'locations'> & Partial<JobObservationPayload>;
  company: {
    licenceCountries?: string[];
    /** Countries of licences no longer on the register (hiring-history input). */
    lapsedLicenceCountries?: string[];
    hqCountry?: string | null;
  } | null;
}

/** The interpretation input of a stored copy, built exactly as reconciliation builds it. */
export function inputFromStoredCopy(stored: StoredCopy): JobInterpretationInput {
  const company = stored.company
    ? ({
        employment: {
          sponsorship: {
            licenceCountries: stored.company.licenceCountries ?? [],
            licences: (stored.company.lapsedLicenceCountries ?? []).map((country) => ({
              country,
              status: 'no_longer_listed',
            })),
          },
        },
        geography: {
          headquarters: { value: stored.company.hqCountry ? { country: stored.company.hqCountry } : null },
        },
      } as unknown as CompanyDoc)
    : null;
  return interpretationInput({ payload: stored.payload } as unknown as JobObservationDoc, company);
}

export interface GoldenCaseResult {
  id: string;
  passed: boolean;
  failures: string[];
}

export interface GoldenReport {
  cases: GoldenCaseResult[];
  passed: number;
  failed: number;
}

const SELECTOR = /^([^[\]]+)\[([^=\]]+)=([^\]]*)\]$/;

/** Resolves a dotted path (with `name[key=value]` selectors) against a value. */
export function getPath(root: unknown, path: string): { found: boolean; value: unknown } {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return { found: false, value: undefined };
    const sel = segment.match(SELECTOR);
    if (sel) {
      const [, name, key, expected] = sel;
      const arr = (current as Record<string, unknown>)[name ?? ''];
      if (!Array.isArray(arr)) return { found: false, value: undefined };
      current = arr.find(
        (el) =>
          el && typeof el === 'object' && String((el as Record<string, unknown>)[key ?? '']) === expected,
      );
      if (current === undefined) return { found: false, value: undefined };
      continue;
    }
    if (typeof current !== 'object' && typeof current !== 'string') return { found: false, value: undefined };
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      if (Number(segment) >= current.length) return { found: false, value: undefined };
      current = current[Number(segment)];
      continue;
    }
    if (typeof current === 'string') {
      if (segment !== 'length') return { found: false, value: undefined };
      current = current.length;
      continue;
    }
    if (!(segment in (current as object))) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function isOperator(v: unknown): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).length === 1 &&
    Object.keys(v)[0]?.startsWith('$') === true
  );
}

/** Checks one expectation; returns a failure message or null. */
export function matchExpectation(
  actual: { found: boolean; value: unknown },
  expected: unknown,
): string | null {
  const show = (v: unknown) => JSON.stringify(v);
  if (isOperator(expected)) {
    const [op, arg] = Object.entries(expected)[0] as [string, unknown];
    const v = actual.value;
    switch (op) {
      case '$exists':
        return actual.found === arg ? null : `expected ${arg ? 'present' : 'absent'}`;
      case '$gte':
        return typeof v === 'number' && typeof arg === 'number' && v >= arg
          ? null
          : `expected >= ${show(arg)}, got ${show(v)}`;
      case '$lte':
        return typeof v === 'number' && typeof arg === 'number' && v <= arg
          ? null
          : `expected <= ${show(arg)}, got ${show(v)}`;
      case '$contains':
        if (Array.isArray(v))
          return v.some((el) => isDeepStrictEqual(el, arg))
            ? null
            : `expected array containing ${show(arg)}, got ${show(v)}`;
        if (typeof v === 'string' && typeof arg === 'string')
          return v.includes(arg) ? null : `expected string containing ${show(arg)}, got ${show(v)}`;
        return `expected array/string containing ${show(arg)}, got ${show(v)}`;
      case '$in':
        return Array.isArray(arg) && arg.some((a) => isDeepStrictEqual(a, v))
          ? null
          : `expected one of ${show(arg)}, got ${show(v)}`;
      case '$not':
        return isDeepStrictEqual(v, arg) ? `expected not ${show(arg)}` : null;
      default:
        return `unknown operator ${op}`;
    }
  }
  if (!actual.found) return `path not found (expected ${show(expected)})`;
  return isDeepStrictEqual(actual.value, expected)
    ? null
    : `expected ${show(expected)}, got ${show(actual.value)}`;
}

const INTERPRETED_FIELDS = [
  'title',
  'employmentType',
  'workModel',
  'remoteScope',
  'officeAttendance',
  'sponsorship',
  'authorization',
  'relocation',
  'compensation',
] as const;

/**
 * Policy invariants every interpretation must satisfy: schema-valid; each non-unknown field has
 * evidence; every span with offsets quotes its source verbatim (≤ 300 chars); no zero salary;
 * company capability never appears as a role statement.
 */
export function checkInterpretationInvariants(
  rawInput: JobInterpretationInput,
  output: JobInterpretation,
): string[] {
  const failures: string[] = [];
  const parsed = jobInterpretationSchema.safeParse(output);
  if (!parsed.success) failures.push(`schema: ${parsed.error.message}`);
  const input = jobInterpretationInputSchema.parse(rawInput);
  const texts: Record<string, string> = {
    title: input.title,
    description: input.descriptionText,
    location: locationFieldText(input.locationTexts),
  };
  const checkSpan = (where: string, span: EvidenceSpan) => {
    if (span.quote.length > MAX_QUOTE_LENGTH)
      failures.push(`${where}: quote longer than ${MAX_QUOTE_LENGTH}`);
    if (span.start === undefined || span.end === undefined) {
      if (span.field !== 'provider' && span.field !== 'company')
        failures.push(`${where}: ${span.field} span without offsets`);
      return;
    }
    // A span into the canonical statement rendering is checked against it (a720377 (1)).
    const source =
      span.field === 'description' && span.rendering === 'html_layout'
        ? input.statementSource?.text
        : texts[span.field];
    if (source === undefined) failures.push(`${where}: offsets into field without text (${span.field})`);
    else if (source.slice(span.start, span.end) !== span.quote)
      failures.push(`${where}: quote does not match offsets`);
  };
  for (const field of INTERPRETED_FIELDS) {
    const f = output[field];
    if (f.confidence !== 'unknown' && f.evidence.length === 0)
      failures.push(`${field}: ${f.confidence} confidence without evidence`);
    f.evidence.forEach((span, i) => checkSpan(`${field}.evidence.${i}`, span));
  }
  output.requirements.forEach((r, i) => checkSpan(`requirements.${i}.evidence`, r.evidence));
  output.flags.forEach((f, i) => {
    if (f.evidence) checkSpan(`flags.${i}.evidence`, f.evidence);
  });
  for (const [name, signal] of Object.entries(output.responsibilities)) {
    signal.evidence.forEach((span, i) => checkSpan(`responsibilities.${name}.evidence.${i}`, span));
  }
  const comp = output.compensation.value;
  if (comp.min === 0 || comp.max === 0) failures.push('compensation: zero amount produced');
  const sp = output.sponsorship.value;
  if (
    (sp.status === 'explicit_yes' && sp.roleStatement !== 'yes') ||
    (sp.status === 'explicit_no' && sp.roleStatement !== 'no')
  ) {
    failures.push('sponsorship: explicit status without a matching role statement');
  }
  return failures;
}

/** Loads fixtures (sorted by file name for deterministic ordering). */
export function loadGoldenCases(fixturesDir: string): GoldenCase[] {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const data = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as Partial<GoldenCase> & {
        stored?: StoredCopy;
      };
      const input = data.input ?? (data.stored ? inputFromStoredCopy(data.stored) : undefined);
      if (!data.id || !input || !data.expect)
        throw new Error(`Invalid golden fixture ${file}: requires id, input (or stored), expect`);
      return {
        id: data.id,
        description: data.description ?? '',
        input,
        expect: data.expect,
        overrides: data.overrides,
      };
    });
}

export function evaluateInterpretationGolden(fixturesDir: string): GoldenReport {
  const cases: GoldenCaseResult[] = loadGoldenCases(fixturesDir).map((c) => {
    const failures: string[] = [];
    let output: JobInterpretation;
    try {
      output = interpretJob(c.input);
    } catch (err) {
      return { id: c.id, passed: false, failures: [`interpretJob threw: ${(err as Error).message}`] };
    }
    const root = c.overrides ? { ...output, canonical: canonicalWithOverrides(output, c.overrides) } : output;
    for (const [path, expected] of Object.entries(c.expect)) {
      const failure = matchExpectation(getPath(root, path), expected);
      if (failure) failures.push(`${path}: ${failure}`);
    }
    failures.push(...checkInterpretationInvariants(c.input, output));
    if (!isDeepStrictEqual(output, interpretJob(c.input))) failures.push('non-deterministic output');
    return { id: c.id, passed: failures.length === 0, failures };
  });
  const passed = cases.filter((c) => c.passed).length;
  return { cases, passed, failed: cases.length - passed };
}

/** The overridable interpreted facts after `applyOverrides`, keyed by override field. */
function canonicalWithOverrides(
  output: JobInterpretation,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const at = new Date(0);
  const job = {
    geography: { workModel: { ...output.workModel }, remoteScope: { ...output.remoteScope } },
    immigration: { sponsorship: { ...output.sponsorship }, relocation: { ...output.relocation } },
    employment: { employmentType: { ...output.employmentType } },
    compensation: { ...output.compensation },
    overrides: Object.fromEntries(
      Object.entries(overrides).map(([field, value]) => [
        field,
        { value, reason: 'golden', actorId: 'golden', at },
      ]),
    ),
  };
  applyOverrides(job as unknown as JobDoc, at, 'operator');
  return Object.fromEntries(
    Object.entries(JOB_OVERRIDE_PATHS).map(([field, path]) => [field, getPath(job, `${path}.value`).value]),
  );
}
