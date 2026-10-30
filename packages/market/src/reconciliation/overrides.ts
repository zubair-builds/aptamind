import type { EvidenceReference, Fact } from '@aptamind/provenance';
import type { JobDoc } from '../jobs/job.schema';

/**
 * Operator overrides of job facts (pure: no database access, so goldens and validators can use
 * it without the Mongo-bound reconciler).
 */

/**
 * job-policy/3: a sponsorship override decides only the role axis; company-axis evidence and the
 * recomputed role statement are kept on the overridden fact (PR #21 review A-M3/B-M1, B-M2).
 * job-policy/2: a sponsorship override freezes only the role axes (B-L2).
 */
export const JOB_RECONCILIATION_POLICY_VERSION = 'job-policy/3';

/**
 * The job facts an operator override replaces, by override field (`job.overrides` keys). The one
 * list `applyOverrides`, the review resolver (`JOB_OVERRIDABLE`) and the review API's correctable
 * descriptors (`JOB_CORRECTABLE_FIELDS`) agree on (tested).
 */
export const JOB_OVERRIDE_PATHS = {
  workModel: 'geography.workModel',
  remoteScope: 'geography.remoteScope',
  sponsorship: 'immigration.sponsorship',
  relocation: 'immigration.relocation',
  compensation: 'compensation',
  employmentType: 'employment.employmentType',
} as const;
export type JobOverrideField = keyof typeof JOB_OVERRIDE_PATHS;

/** Reason recorded on the conflict that keeps the value an override replaced. */
export const OVERRIDDEN_BY_OPERATOR = 'overridden by operator';

/**
 * Role-axis statuses a job-level sponsorship correction may set, with the role statement each
 * implies (ruling on PR #21 A-M3/B-M1). `company_capable` and `historical_evidence` describe the
 * COMPANY; correcting a wrongly matched licence is a company-level action.
 */
export const SPONSORSHIP_ROLE_STATUSES = {
  explicit_yes: 'yes',
  explicit_no: 'no',
  unclear: 'none',
} as const;

/** Why `value` is not an acceptable job-level sponsorship correction, or null. */
export function sponsorshipCorrectionProblem(value: unknown): string | null {
  if (!isObject(value)) return 'sponsorship must be an object with status and roleStatement';
  const status = value.status as string;
  if (!Object.hasOwn(SPONSORSHIP_ROLE_STATUSES, status))
    return `a job-level sponsorship correction decides only the role: status must be explicit_yes, explicit_no or unclear (got ${String(status)}); ${status === 'company_capable' || status === 'historical_evidence' ? 'company capability and hiring history are company-level evidence — correct the company instead' : 'unknown status'}`;
  const expected = SPONSORSHIP_ROLE_STATUSES[status as keyof typeof SPONSORSHIP_ROLE_STATUSES];
  if (value.roleStatement !== expected)
    return `status ${status} requires roleStatement ${expected} (got ${String(value.roleStatement)})`;
  return null;
}

/** An override `applyOverrides` could not apply as recorded (raised for review by reconciliation). */
export interface RejectedOverride {
  field: JobOverrideField;
  reason: string;
  value: unknown;
}

/**
 * Apply `job.overrides` to its facts (reconciliation calls it after interpretation). Returns the
 * overrides that were not applied as recorded: a stored sponsorship override with a company-axis
 * status (possible only before the role-axis rule) keeps the status re-derived from current
 * evidence, and is reported so an operator can decide again.
 */
export function applyOverrides(job: JobDoc, now: Date, sourceId: string): RejectedOverride[] {
  const rejected: RejectedOverride[] = [];
  const operatorFact = <T>(value: T, o: { reason: string; actorId: string; at: Date }): Fact<T> => ({
    value,
    status: 'known',
    confidence: { level: 'high', reasons: [`operator override: ${o.reason}`] },
    // Evidence cites the `system:operator` source (a real source id, linkable like any other).
    evidence: [{ sourceId, locator: `override by ${o.actorId}`, observedAt: o.at, authority: 'operator' }],
    conflicts: [],
    policyVersion: JOB_RECONCILIATION_POLICY_VERSION,
    updatedAt: now,
  });
  for (const [field, o] of Object.entries(job.overrides)) {
    if (!Object.hasOwn(JOB_OVERRIDE_PATHS, field)) continue;
    const path: string = JOB_OVERRIDE_PATHS[field as JobOverrideField];
    const [group, key] = path.includes('.') ? (path.split('.') as [string, string]) : [null, path];
    const holder = (
      group ? (job as unknown as Record<string, Record<string, unknown>>)[group] : job
    ) as Record<string, unknown>;
    const recomputed = holder[key] as Fact<unknown> | undefined;
    if (field === 'sponsorship') {
      if (isObject(o.value) && !Object.hasOwn(SPONSORSHIP_ROLE_STATUSES, o.value.status as string)) {
        rejected.push({
          field: 'sponsorship',
          value: o.value,
          reason: `stored override sets the company-axis status ${String(o.value.status)}; the status is re-derived from current evidence`,
        });
        continue; // the recomputed fact stands
      }
      const fact = operatorFact(sponsorshipOverride(o.value, recomputed?.value), o);
      if (recomputed) {
        // Company-axis evidence (licence references) stays visible next to the operator span, and
        // the recomputed role reading is kept as an alternate behind the decision (B-M2).
        const companyEvidence = recomputed.evidence.filter((e) => !isJobTextEvidence(e));
        fact.evidence = [...fact.evidence, ...companyEvidence];
        // Other copies' values stay behind the decision as alternates: appended, never replaced
        // by the operator reading (DECISION_LOG 3dfe3c5 (2)).
        fact.conflicts = [
          {
            value: recomputed.value,
            evidence: recomputed.evidence.filter(isJobTextEvidence),
            reason: OVERRIDDEN_BY_OPERATOR,
          },
          ...(recomputed.conflicts ?? []).filter((c) => c.reason !== OVERRIDDEN_BY_OPERATOR),
        ];
      }
      holder[key] = fact;
      continue;
    }
    const fact: Fact<unknown> = operatorFact(o.value as unknown, o);
    // The work model keeps the value it replaced as a conflict (the others start clean).
    if (field === 'workModel')
      fact.conflicts = [{ value: recomputed?.value ?? null, evidence: [], reason: OVERRIDDEN_BY_OPERATOR }];
    holder[key] = fact;
  }
  return rejected;
}

/**
 * A sponsorship override freezes only the ROLE axes (`status`, `roleStatement`): the operator
 * decides what the role offers. The COMPANY axis (`companyCapability`, `capabilityCountries`) is
 * recomputed from current evidence on every reconciliation, so a licence gained or lapsed after
 * the decision still shows (PR #10 follow-up B-L2).
 */
export function sponsorshipOverride(overrideValue: unknown, recomputed: unknown): unknown {
  if (!isObject(overrideValue) || !isObject(recomputed)) return overrideValue;
  return {
    ...overrideValue,
    companyCapability: recomputed.companyCapability ?? overrideValue.companyCapability,
    capabilityCountries: recomputed.capabilityCountries ?? overrideValue.capabilityCountries,
  };
}

/** Evidence quoted from the job's own text (the interpreter), as opposed to company evidence. */
function isJobTextEvidence(e: EvidenceReference): boolean {
  return e.extractor?.name === 'job-interpreter';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * How a fact's sources disagree (the one definition companies and jobs share, PR #21 follow-up):
 * - `conflicting`: the policy could not pick a value (`status: conflicting`);
 * - `same_authority`: a value was picked among sources of the same authority that disagree;
 * - `alternates`: the value was picked by authority, lower-authority values are kept;
 * - `null`: no source disagreement (the value an operator override replaced is not one).
 * `quality.conflictFields` lists the facts that are `conflicting` or `same_authority`.
 */
export type DisagreementKind = 'conflicting' | 'same_authority' | 'alternates';

export function disagreementOf(f: Fact<unknown>): DisagreementKind | null {
  if (f.status === 'conflicting') return 'conflicting';
  const sourceConflicts = f.conflicts.filter((c) => c.reason !== OVERRIDDEN_BY_OPERATOR);
  if (sourceConflicts.some((c) => c.reason.startsWith('same authority disagreement')))
    return 'same_authority';
  return sourceConflicts.length ? 'alternates' : null;
}

/** Whether the fact belongs in `quality.conflictFields`. */
export function isConflictField(f: Fact<unknown>): boolean {
  const kind = disagreementOf(f);
  return kind === 'conflicting' || kind === 'same_authority';
}
