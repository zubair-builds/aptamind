import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { CLAIM_TYPE_DEFS, type ClaimType, claimTypesInSection } from './claims';
import {
  capabilityProfileV1Schema,
  careerTargetsV1Schema,
  careerTargetViabilityV1Schema,
  eligibilityV1Schema,
  preferencesV1Schema,
  READ_MODELS_V1,
} from './read-models';
import { schemaPaths } from './schema-paths';
import { targetFitSchema, targetSpecSchema } from './targets';

/** The claim types a read model can carry: every `claimType` literal in its schema. */
function claimTypesOf(schema: ZodType): Set<string> {
  const out = new Set<string>();
  const walk = (s: ZodType) => {
    const d = (s as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
    if (d.type === 'object') {
      const shape = d.shape as Record<string, ZodType>;
      const ct = shape.claimType
        ? ((shape.claimType as unknown as { _zod: { def: { values: string[] } } })._zod.def.values ?? [])
        : [];
      for (const v of ct) out.add(v);
      for (const v of Object.values(shape)) walk(v);
    } else if (d.type === 'array') walk(d.element as ZodType);
    else if (d.innerType) walk(d.innerType as ZodType);
  };
  walk(schema);
  return out;
}

/**
 * Viability field names: authorization, visa, sponsorship, relocation — never in capability,
 * preferences or targets.
 */
const VIABILITY_FIELDS = [
  'eligibility',
  'workAuthorization',
  'work_authorization',
  'jurisdiction',
  'visa',
  'visaType',
  'sponsorship',
  'sponsorshipRequired',
  'validUntil',
  'relocation',
  'mobility',
  'willing',
  'destinations',
  'citizenship',
  'nationality',
];

/**
 * Everything the capability profile must never carry, at any depth: viability fields, where the
 * subject (or a past workplace) is located, and compensation.
 */
const CAPABILITY_FORBIDDEN = [
  ...VIABILITY_FIELDS,
  'location',
  'country',
  'city',
  'region',
  'compensation',
  'currency',
];

/** Every path segment (at any depth) a schema can produce. */
const segments = (schema: ZodType) =>
  new Set(schemaPaths(schema).flatMap((p) => p.replace(/\[\]/g, '').split('.')));

const stamp = {
  subjectId: 'psub_1',
  profileVersion: 3,
  policyVersion: 'prof-rec-1',
  taxonomyVersion: '2026-09-27.1',
  generatedAt: new Date('2026-09-29T00:00:00Z'),
};
const conf = { level: 'high' as const, reasons: ['confirmed'] };
const emptyCapability = {
  model: 'professional.capability_profile',
  schemaVersion: 1,
  stamp,
  headline: null,
  roles: [],
  skills: [
    {
      itemId: 'pitm_s',
      claimType: 'skill',
      value: { label: 'Go', concept: 'go', kind: 'skill', context: 'listed' },
      status: 'known',
      basis: 'confirmed',
      confidence: conf,
      confirmed: true,
    },
  ],
  education: [],
  certifications: [],
  languages: [],
  projects: [],
  achievements: [],
  portfolioEvidence: [],
  industries: [],
};
const locationEntry = {
  itemId: 'pitm_l',
  claimType: 'location.current',
  value: { country: 'DE' },
  status: 'known',
  basis: 'stated',
  confidence: conf,
  confirmed: false,
};

describe('CapabilityProfileV1 cannot contain eligibility (PL-9)', () => {
  it('carries capability-section claim types only, and all of them', () => {
    const types = claimTypesOf(capabilityProfileV1Schema);
    for (const t of types) expect(CLAIM_TYPE_DEFS[t as ClaimType].section, t).toBe('capability');
    expect([...types].sort()).toEqual(claimTypesInSection('capability').sort());
  });

  it('has no eligibility, location or compensation field at any depth of any path', () => {
    const all = segments(capabilityProfileV1Schema);
    for (const f of CAPABILITY_FORBIDDEN) expect(all.has(f), f).toBe(false);
  });

  it('exports roles without their workplace location (kept on the item)', () => {
    const role = {
      itemId: 'pitm_r',
      claimType: 'experience.role',
      value: {
        organization: { name: 'Acme Ltd', key: 'acme' },
        title: 'Engineer',
        titleKey: 'engineer',
        start: { year: 2019 },
        end: { year: 2021 },
      },
      status: 'known',
      basis: 'extracted',
      confidence: conf,
      confirmed: false,
    };
    expect(capabilityProfileV1Schema.safeParse({ ...emptyCapability, roles: [role] }).success).toBe(true);
    const located = { ...role, value: { ...role.value, location: { country: 'GB' } } };
    expect(capabilityProfileV1Schema.safeParse({ ...emptyCapability, roles: [located] }).success).toBe(false);
  });

  it('parses a valid profile and rejects smuggled eligibility data', () => {
    expect(capabilityProfileV1Schema.safeParse(emptyCapability).success).toBe(true);
    // An extra top-level section (strict objects).
    expect(capabilityProfileV1Schema.safeParse({ ...emptyCapability, location: locationEntry }).success).toBe(
      false,
    );
    expect(capabilityProfileV1Schema.safeParse({ ...emptyCapability, workAuthorization: [] }).success).toBe(
      false,
    );
    // An eligibility item disguised as a capability entry.
    expect(capabilityProfileV1Schema.safeParse({ ...emptyCapability, skills: [locationEntry] }).success).toBe(
      false,
    );
    // An extra field on an entry or inside a value.
    const [skill] = emptyCapability.skills;
    expect(
      capabilityProfileV1Schema.safeParse({ ...emptyCapability, skills: [{ ...skill, visa: 'x' }] }).success,
    ).toBe(false);
    expect(
      capabilityProfileV1Schema.safeParse({
        ...emptyCapability,
        skills: [{ ...skill, value: { ...skill!.value, sponsorshipRequired: 'yes' } }],
      }).success,
    ).toBe(false);
  });
});

describe('the other read models stay in their sections', () => {
  it('EligibilityV1 carries eligibility claim types only, and never skills or experience', () => {
    const types = claimTypesOf(eligibilityV1Schema);
    expect([...types].sort()).toEqual(claimTypesInSection('eligibility').sort());
    const fields = segments(eligibilityV1Schema);
    for (const f of ['skills', 'roles', 'education', 'titleKey', 'organization'])
      expect(fields.has(f), f).toBe(false);
  });

  it('PreferencesV1 carries preference claim types only', () => {
    const types = claimTypesOf(preferencesV1Schema);
    expect([...types].sort()).toEqual(claimTypesInSection('preferences').sort());
    const all = segments(preferencesV1Schema);
    for (const f of [...VIABILITY_FIELDS, 'location', 'country', 'city', 'region'])
      expect(all.has(f), f).toBe(false);
  });

  it('career targets carry no eligibility field (R-28)', () => {
    for (const schema of [targetSpecSchema, careerTargetsV1Schema, careerTargetViabilityV1Schema]) {
      const all = segments(schema);
      for (const f of VIABILITY_FIELDS) expect(all.has(f), f).toBe(false);
    }
    expect(claimTypesOf(careerTargetsV1Schema).size).toBe(0);
  });

  it('the fit part of career targets carries no viability data at any depth (INTEGRATION_CONTRACTS §4)', () => {
    const forbidden = [
      ...CAPABILITY_FORBIDDEN,
      'viability',
      'geography',
      'workModels',
      'remoteScope',
      'timezoneWindow',
      'constraints',
      'rationale',
    ];
    for (const schema of [targetFitSchema, careerTargetsV1Schema]) {
      const all = segments(schema);
      for (const f of forbidden) expect(all.has(f), f).toBe(false);
    }
  });

  it('identity is in no v1 read model', () => {
    for (const schema of Object.values(READ_MODELS_V1)) {
      for (const t of claimTypesOf(schema))
        expect(CLAIM_TYPE_DEFS[t as ClaimType].section).not.toBe('identity');
    }
  });
});

describe('read-model stamps (PL-13)', () => {
  it.each(Object.entries(READ_MODELS_V1))(
    '%s requires the (subjectId, profileVersion) stamp',
    (_name, schema) => {
      const paths = schemaPaths(schema);
      for (const p of ['subjectId', 'profileVersion', 'policyVersion', 'taxonomyVersion', 'generatedAt'])
        expect(paths).toContain(`stamp.${p}`);
    },
  );

  it('rejects a capability profile without a stamp', () => {
    const { stamp: _s, ...rest } = emptyCapability;
    expect(capabilityProfileV1Schema.safeParse(rest).success).toBe(false);
  });
});

describe('entry consistency (B-M4)', () => {
  const [skill] = emptyCapability.skills;
  const withSkill = (patch: Record<string, unknown>) =>
    capabilityProfileV1Schema.safeParse({ ...emptyCapability, skills: [{ ...skill, ...patch }] }).success;

  it('confirmed ⇔ basis = confirmed', () => {
    expect(withSkill({ confirmed: true, basis: 'confirmed' })).toBe(true);
    expect(withSkill({ confirmed: false, basis: 'confirmed' })).toBe(false);
    expect(withSkill({ confirmed: true, basis: 'stated' })).toBe(false);
    expect(withSkill({ confirmed: false, basis: 'stated' })).toBe(true);
  });

  it('value = null ⇔ status ∈ { unknown, conflicting }', () => {
    expect(withSkill({ value: null, status: 'unknown', basis: null, confirmed: false })).toBe(true);
    expect(withSkill({ value: null, status: 'conflicting', basis: 'extracted', confirmed: false })).toBe(
      true,
    );
    expect(withSkill({ value: null, status: 'known' })).toBe(false);
    expect(withSkill({ status: 'unknown' })).toBe(false);
    expect(withSkill({ status: 'conflicting' })).toBe(false);
  });

  it('only eligibility work authorization can be expired (value still shown)', () => {
    const elig = {
      model: 'professional.eligibility',
      schemaVersion: 1,
      stamp,
      location: null,
      relocation: null,
      workAuthorization: [
        {
          itemId: 'pitm_w',
          claimType: 'work_authorization',
          value: {
            jurisdiction: 'GB',
            status: 'visa',
            validUntil: { year: 2020 },
            sponsorshipRequired: 'yes',
          },
          status: 'expired',
          basis: 'confirmed',
          confidence: conf,
          confirmed: true,
        },
      ],
    };
    expect(eligibilityV1Schema.safeParse(elig).success).toBe(true);
    expect(
      eligibilityV1Schema.safeParse({ ...elig, location: { ...locationEntry, status: 'expired' } }).success,
    ).toBe(false);
    expect(withSkill({ status: 'expired' })).toBe(false);
  });
});

describe('strict ids and dates in read models (B-L1, B-L2)', () => {
  it('rejects non-prefixed ids', () => {
    expect(
      capabilityProfileV1Schema.safeParse({ ...emptyCapability, stamp: { ...stamp, subjectId: 'x1' } })
        .success,
    ).toBe(false);
    const [skill] = emptyCapability.skills;
    expect(
      capabilityProfileV1Schema.safeParse({ ...emptyCapability, skills: [{ ...skill, itemId: 'psub_1' }] })
        .success,
    ).toBe(false);
  });

  it.each([null, true, 0, '2026-09-29', 'yesterday', new Date('invalid')])(
    'generatedAt rejects %s',
    (generatedAt) => {
      expect(
        capabilityProfileV1Schema.safeParse({ ...emptyCapability, stamp: { ...stamp, generatedAt } }).success,
      ).toBe(false);
    },
  );

  it('generatedAt accepts a Date or an ISO date-time with offset (normalized to a Date)', () => {
    const r = capabilityProfileV1Schema.safeParse({
      ...emptyCapability,
      stamp: { ...stamp, generatedAt: '2026-09-29T10:00:00+02:00' },
    });
    expect(r.success && r.data.stamp.generatedAt).toEqual(new Date('2026-09-29T08:00:00Z'));
  });
});
