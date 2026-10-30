import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@aptamind/contracts';
import { targetFitSchema, targetSpecSchema, targetViabilitySchema } from '../contracts/targets';
import type { CareerTargetDoc, CareerTargetVersionDoc } from './target.schema';
import { diffVersions, viewTarget, viewVersion } from './views';

const CANARY = 'canaryviability01';
const now = new Date('2026-09-29T10:00:00Z');
const spec = targetSpecSchema.parse({
  label: 'Data platform lead',
  fit: { roleFamilies: ['data_engineering'], seniority: { min: 'senior' } },
  viability: {
    geography: [{ scope: 'city', code: 'DE', city: CANARY, mode: 'live_in' }],
    workModels: { acceptable: ['hybrid'] },
    compensation: { currency: 'EUR', min: 90000, period: 'year', basis: 'base_salary' },
    constraints: [{ kind: 'other', value: CANARY, strength: 'soft' }],
  },
  rationale: `wants to move to ${CANARY}`,
});
const target: CareerTargetDoc = {
  _id: 'ptgt_1',
  subjectId: 'psub_1',
  status: 'active',
  priority: 1,
  spec,
  origin: 'stated',
  basis: 'confirmed',
  rev: 0,
  version: 1,
  createRequestHash: '0'.repeat(64),
  createdBy: { kind: 'internal-operator', id: 'op' },
  schemaVersion: 1,
  createdAt: now,
  updatedAt: now,
};
const version = (n: number, over: Partial<CareerTargetVersionDoc> = {}): CareerTargetVersionDoc => ({
  _id: `ptgv_${n}`,
  subjectId: 'psub_1',
  targetId: 'ptgt_1',
  version: n,
  status: 'active',
  priority: 1,
  spec,
  origin: 'stated',
  basis: 'confirmed',
  cause: { kind: 'created', reason: 'operator_stated' },
  actor: { kind: 'internal-operator', id: 'op' },
  attestation: { mode: 'operator_relayed' },
  schemaVersion: 1,
  createdAt: now,
  updatedAt: now,
  ...over,
});

describe('sensitive projection (R-30)', () => {
  it('omits the viability part and the rationale by default, never the fit part', () => {
    const v = viewTarget(target, false);
    expect(v.sensitive).toBe('omitted');
    expect(canonicalJson(v)).not.toContain(CANARY);
    expect(v.spec).toEqual({ label: spec.label, fit: spec.fit });
    expect(v).not.toHaveProperty('createRequestHash');
    expect(canonicalJson(viewVersion(version(1), false))).not.toContain(CANARY);
  });

  it('pins the fit part with fitHash, independent of the sensitive viability part', () => {
    const v = viewTarget(target, false);
    expect(v.fitHash).toMatch(/^[0-9a-f]{64}$/);
    const moved = { ...target, spec: { ...spec, viability: { geography: [], constraints: [] } } };
    expect(viewTarget(moved, true).fitHash).toBe(v.fitHash);
    const refocused = {
      ...target,
      spec: { ...spec, fit: { ...spec.fit, seniority: { min: 'staff' as const } } },
    };
    expect(viewTarget(refocused, false).fitHash).not.toBe(v.fitHash);
  });

  it('returns everything with include=sensitive', () => {
    const v = viewTarget(target, true);
    expect(v.sensitive).toBe('included');
    expect(v.spec).toEqual(spec);
  });
});

describe('version diff (R-24)', () => {
  const edited = targetSpecSchema.parse({
    ...spec,
    fit: { ...spec.fit, seniority: { min: 'staff' } },
    viability: { ...spec.viability, workModels: { acceptable: ['remote'] } },
  });

  it('lists changed paths with values; sensitive ones by path only without include=sensitive', () => {
    const a = version(1);
    const b = version(2, { spec: edited, priority: 2 });
    const d = diffVersions(a, b, false);
    expect(d.changes).toEqual([
      { path: 'priority', from: 1, to: 2 },
      { path: 'spec.fit.seniority', from: { min: 'senior' }, to: { min: 'staff' } },
      { path: 'spec.viability.workModels', sensitive: true },
    ]);
    expect(canonicalJson(d)).not.toContain(CANARY);
    const full = diffVersions(a, b, true);
    expect(full.changes).toContainEqual({
      path: 'spec.viability.workModels',
      from: { acceptable: ['hybrid'] },
      to: { acceptable: ['remote'] },
    });
  });

  it('covers every spec field (a new field cannot be silently left out of diffs)', () => {
    const fitKeys = Object.keys(targetFitSchema.shape);
    const viaKeys = Object.keys(targetViabilitySchema.shape);
    const everything = version(2, {
      spec: targetSpecSchema.parse({
        label: 'x',
        fit: {
          roleFamilies: ['design'],
          specializations: [],
          titles: ['t'],
          seniority: { max: 'lead' },
          skillsFocus: [{ label: 'Figma', concept: 'figma' }],
          industries: [],
          domains: ['d'],
          excludedIndustries: [],
          companyStages: [],
          employmentTypes: [],
        },
        viability: {
          geography: [],
          workModels: { acceptable: ['onsite'] },
          remoteScope: { timezoneWindow: { minUtcOffset: 0, maxUtcOffset: 2 } },
          compensation: { currency: 'EUR', target: 1, period: 'year', basis: 'base_salary' },
          constraints: [],
        },
      }),
    });
    const paths = diffVersions(version(1), everything, true).changes.map((c) => c.path);
    for (const k of fitKeys) expect(paths, k).toContain(`spec.fit.${k}`);
    for (const k of viaKeys.filter((k) => k !== 'geography' && k !== 'constraints'))
      expect(paths, k).toContain(`spec.viability.${k}`);
    expect(paths).toEqual(expect.arrayContaining(['spec.label', 'spec.rationale']));
  });
});
