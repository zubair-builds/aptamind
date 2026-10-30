import { canonicalJson, contentHash } from '@aptamind/contracts';
import { SENSITIVE_TARGET_SPEC_FIELDS, type TargetSpec, type TargetSpecPublic } from '../contracts/targets';
import type { CareerTargetDoc, CareerTargetVersionDoc } from './target.schema';

/**
 * Sensitive-data projection and version diffs for career targets. Pure: no I/O.
 *
 * R-30 / DECISION_LOG (PR #24): sensitive data is excluded by default. A target's viability part
 * (geography — where the subject lives, would relocate or commute to, work remotely from — work
 * models, timezone window, compensation, constraints) and its free-text rationale are returned
 * only with `include=sensitive`; without it they are omitted and `sensitive: 'omitted'` says so.
 */
export type SensitiveMode = 'omitted' | 'included';

export type TargetSpecView = TargetSpec | TargetSpecPublic;

export function viewSpec(spec: TargetSpec, includeSensitive: boolean): TargetSpecView {
  if (includeSensitive) return spec;
  const out: Record<string, unknown> = { ...spec };
  for (const f of SENSITIVE_TARGET_SPEC_FIELDS) delete out[f];
  return out as TargetSpecPublic;
}

/**
 * Drift pin over the fit-relevant part (`label` + `fit`), like the cross-domain `factsHash`: a
 * consumer that scored `(targetId, version)` can tell whether the fit part changed since. It
 * never covers the sensitive viability part. It is a hash of the stored value as given: array
 * order counts (reordering role families changes it) and the label is included (a rename changes
 * it). Arrays are not normalized, because a caller may use order to express preference.
 */
export function targetFitHash(spec: Pick<TargetSpec, 'label' | 'fit'>): string {
  return contentHash({ label: spec.label, fit: spec.fit });
}

export type CareerTargetView = Omit<CareerTargetDoc, 'spec' | 'createRequestHash'> & {
  spec: TargetSpecView;
  fitHash: string;
  sensitive: SensitiveMode;
};

export function viewTarget(doc: CareerTargetDoc, includeSensitive: boolean): CareerTargetView {
  const { createRequestHash: _hash, spec, ...rest } = doc;
  return {
    ...rest,
    spec: viewSpec(spec, includeSensitive),
    fitHash: targetFitHash(spec),
    sensitive: includeSensitive ? 'included' : 'omitted',
  };
}

export type CareerTargetVersionView = Omit<CareerTargetVersionDoc, 'spec'> & {
  spec: TargetSpecView;
  fitHash: string;
  sensitive: SensitiveMode;
};

export function viewVersion(doc: CareerTargetVersionDoc, includeSensitive: boolean): CareerTargetVersionView {
  return {
    ...doc,
    spec: viewSpec(doc.spec, includeSensitive),
    fitHash: targetFitHash(doc.spec),
    sensitive: includeSensitive ? 'included' : 'omitted',
  };
}

export interface TargetChange {
  /** `status`, `priority`, `spec.label`, `spec.fit.<field>`, `spec.viability.<field>`, `spec.rationale`. */
  path: string;
  from?: unknown;
  to?: unknown;
  /** Set on sensitive paths without `include=sensitive`: the values are omitted. */
  sensitive?: true;
}

export interface TargetDiff {
  targetId: string;
  from: number;
  to: number;
  changes: TargetChange[];
  sensitive: SensitiveMode;
}

const FIT_FIELDS = [
  'roleFamilies',
  'specializations',
  'titles',
  'seniority',
  'skillsFocus',
  'industries',
  'domains',
  'excludedIndustries',
  'companyStages',
  'employmentTypes',
] as const;
const VIABILITY_FIELDS = ['geography', 'workModels', 'remoteScope', 'compensation', 'constraints'] as const;

/**
 * Field-level diff between two versions of one target (R-24). Without `include=sensitive`,
 * changes to the viability part or the rationale are reported by path only (`sensitive: true`),
 * never with values.
 */
export function diffVersions(
  a: CareerTargetVersionDoc,
  b: CareerTargetVersionDoc,
  includeSensitive: boolean,
): TargetDiff {
  const changes: TargetChange[] = [];
  const cmp = (path: string, x: unknown, y: unknown, sensitive = false) => {
    if (canonicalJson(x ?? null) === canonicalJson(y ?? null)) return;
    if (sensitive && !includeSensitive) changes.push({ path, sensitive: true });
    else
      changes.push({ path, ...(x === undefined ? {} : { from: x }), ...(y === undefined ? {} : { to: y }) });
  };
  cmp('status', a.status, b.status);
  cmp('priority', a.priority, b.priority);
  cmp('basis', a.basis, b.basis);
  cmp('spec.label', a.spec.label, b.spec.label);
  for (const f of FIT_FIELDS) cmp(`spec.fit.${f}`, a.spec.fit[f], b.spec.fit[f]);
  for (const f of VIABILITY_FIELDS)
    cmp(`spec.viability.${f}`, a.spec.viability[f], b.spec.viability[f], true);
  cmp('spec.rationale', a.spec.rationale, b.spec.rationale, true);
  return {
    targetId: a.targetId,
    from: a.version,
    to: b.version,
    changes,
    sensitive: includeSensitive ? 'included' : 'omitted',
  };
}
