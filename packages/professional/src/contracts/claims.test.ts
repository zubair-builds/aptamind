import { describe, expect, it } from 'vitest';
import {
  CLAIM_TYPE_DEFS,
  CLAIM_TYPES,
  CLAIM_VALUE_SCHEMAS,
  type ClaimType,
  claimSchema,
  claimTypesInSection,
  parseClaimValue,
} from './claims';
import { schemaFieldNames } from './schema-paths';

/**
 * The domain document's §3.2 table (section, class) plus §5.2 sensitivity and §7.2
 * materiality, transcribed independently of the registry.
 */
const DOC: Record<ClaimType, [section: string, fieldClass: string, sensitivity: string, material: boolean]> =
  {
    'identity.name': ['identity', 'current_state', 'personal', true],
    'identity.link': ['identity', 'set_member', 'personal', false],
    'positioning.headline': ['capability', 'current_state', 'standard', false],
    'experience.role': ['capability', 'historical', 'standard', true],
    skill: ['capability', 'set_member', 'standard', false],
    education: ['capability', 'historical', 'standard', true],
    certification: ['capability', 'historical', 'standard', true],
    language: ['capability', 'set_member', 'standard', false],
    'location.current': ['eligibility', 'current_state', 'sensitive', true],
    work_authorization: ['eligibility', 'historical', 'sensitive', true],
    'mobility.relocation': ['eligibility', 'current_state', 'sensitive', false],
    'preference.remote': ['preferences', 'current_state', 'standard', false],
    project: ['capability', 'historical', 'standard', false],
    achievement: ['capability', 'historical', 'standard', false],
    'portfolio.evidence': ['capability', 'set_member', 'standard', false],
    industry: ['capability', 'set_member', 'standard', false],
    'preference.compensation': ['preferences', 'current_state', 'sensitive', false],
    'preference.career': ['preferences', 'current_state', 'sensitive', false],
  };

/** One valid value per claim type, and invalid variants that must be rejected. */
const VALID: Record<ClaimType, unknown> = {
  'identity.name': { display: 'Persona Alpha' },
  'identity.link': { kind: 'github', url: 'https://github.example/persona-alpha' },
  'positioning.headline': { text: 'Backend engineer' },
  'experience.role': {
    organization: { name: 'Acme Ltd', key: 'acme' },
    title: 'Senior Engineer',
    titleKey: 'senior_engineer',
    seniority: 'senior',
    start: { year: 2019, month: 3 },
    end: { open: true, asOf: '2024-01-15T00:00:00.000Z' },
    location: { city: 'London', country: 'GB' },
  },
  skill: { label: 'TypeScript', concept: 'typescript', kind: 'skill', context: 'listed' },
  education: {
    institution: { name: 'Example University', key: 'example_university' },
    qualification: 'BSc Computer Science',
    status: 'completed',
    end: { year: 2015 },
  },
  certification: { name: 'Cloud Practitioner', issuer: 'Example Cloud', issued: { year: 2022 } },
  language: { label: 'English', language: 'english', proficiency: 'native' },
  'location.current': { city: 'Berlin', country: 'DE' },
  work_authorization: { jurisdiction: 'EU', status: 'citizen_or_equivalent', sponsorshipRequired: 'no' },
  'mobility.relocation': { willing: 'conditional', destinations: ['GB', 'DACH'] },
  'preference.remote': { acceptable: ['remote', 'hybrid'], preferred: 'remote' },
  project: { name: 'Ledger rewrite', technologies: ['Go'], period: { start: { year: 2021 } } },
  achievement: { text: 'Cut p99 latency by 40%', metrics: [{ value: 40, unit: '%', quote: 'by 40%' }] },
  'portfolio.evidence': { kind: 'repository', title: 'ledger', relatesTo: ['pitm_1'] },
  industry: { label: 'Fintech', code: 'fintech' },
  'preference.compensation': {
    currency: 'EUR',
    min: 80000,
    target: 95000,
    period: 'year',
    basis: 'base_salary',
  },
  'preference.career': { statementRef: 'pobs_1' },
};

const INVALID: Array<[ClaimType, unknown, string]> = [
  ['identity.name', { display: '' }, 'empty name'],
  ['identity.name', { display: 'X', dateOfBirth: '1990-01-01' }, 'protected field smuggled in'],
  ['identity.link', { kind: 'myspace', url: 'x' }, 'unknown link kind'],
  ['identity.link', { kind: 'website', url: 'javascript:alert(1)' }, 'non-http URL'],
  [
    'preference.career',
    { statementRef: 'I want to lead a platform team' },
    'free text instead of an observation id',
  ],
  ['portfolio.evidence', { kind: 'repository', title: 'x', relatesTo: ['role one'] }, 'non-item ref'],
  [
    'experience.role',
    { ...(VALID['experience.role'] as object), start: { year: 2019, month: 13 } },
    'month 13',
  ],
  ['experience.role', { ...(VALID['experience.role'] as object), end: { open: false } }, 'open must be true'],
  ['experience.role', { ...(VALID['experience.role'] as object), seniority: 'wizard' }, 'unknown seniority'],
  [
    'skill',
    { label: 'Rust', kind: 'skill', context: 'listed' },
    'concept must be present (null if unmatched)',
  ],
  ['language', { label: 'Klingon', language: 'klingon', proficiency: 'native' }, 'non-taxonomy language'],
  ['location.current', { city: 'Nowhere' }, 'country required'],
  ['location.current', { country: 'gb' }, 'lower-case country'],
  ['location.current', { country: 'XX' }, 'unknown country'],
  ['work_authorization', { jurisdiction: 'GB', status: 'visa' }, 'sponsorshipRequired required'],
  [
    'work_authorization',
    { jurisdiction: 'MARS', status: 'visa', sponsorshipRequired: 'no' },
    'unknown jurisdiction',
  ],
  ['preference.remote', { acceptable: [] }, 'at least one work model'],
  ['preference.remote', { acceptable: ['unclear'] }, "'unclear' is not a preference"],
  ['preference.compensation', { currency: 'EUR', period: 'year', basis: 'base_salary' }, 'no amount'],
  [
    'preference.compensation',
    { currency: 'EUR', min: 9, target: 5, period: 'year', basis: 'base_salary' },
    'min > target',
  ],
  [
    'preference.compensation',
    { currency: 'XYZ', min: 1, period: 'year', basis: 'base_salary' },
    'unknown currency',
  ],
  ['industry', { label: 'Space', code: 'space_mining' }, 'non-taxonomy industry'],
];

/** Protected characteristics never have a field in any claim value (§5.2, R-11). */
const PROTECTED_FIELDS = [
  'dateOfBirth',
  'birthDate',
  'age',
  'gender',
  'sex',
  'maritalStatus',
  'nationality',
  'citizenship',
  'ethnicity',
  'race',
  'religion',
  'health',
  'disability',
  'photo',
  'nationalId',
  'passportNumber',
  'street',
  'streetAddress',
  'address',
  'postcode',
];

describe('claim type registry', () => {
  it('has exactly the documented claim types', () => {
    expect([...CLAIM_TYPES].sort()).toEqual(Object.keys(DOC).sort());
  });

  it.each(CLAIM_TYPES)('%s matches the domain document (section, class, sensitivity, materiality)', (t) => {
    const d = CLAIM_TYPE_DEFS[t];
    expect([d.section, d.fieldClass, d.sensitivity, d.material]).toEqual(DOC[t]);
  });

  it('the eligibility section is exactly location, work authorization and relocation', () => {
    expect(claimTypesInSection('eligibility').sort()).toEqual([
      'location.current',
      'mobility.relocation',
      'work_authorization',
    ]);
  });

  it('a timezone window is a sensitive field of the remote preference (it reveals location)', () => {
    expect(CLAIM_TYPE_DEFS['preference.remote'].sensitiveFields).toEqual(['timezoneWindow']);
    const withFields = CLAIM_TYPES.filter((t) => CLAIM_TYPE_DEFS[t].sensitiveFields);
    expect(withFields).toEqual(['preference.remote']);
  });

  it('eligibility and compensation are sensitive', () => {
    for (const t of [...claimTypesInSection('eligibility'), 'preference.compensation' as const])
      expect(CLAIM_TYPE_DEFS[t].sensitivity).toBe('sensitive');
  });
});

describe('claim value schemas', () => {
  it.each(CLAIM_TYPES)('%s accepts a valid value, via parseClaimValue and the claim union', (t) => {
    expect(() => parseClaimValue(t, VALID[t])).not.toThrow();
    expect(claimSchema.safeParse({ claimType: t, value: VALID[t] }).success).toBe(true);
  });

  it.each(INVALID)('%s rejects: %#', (t, value) => {
    expect(CLAIM_VALUE_SCHEMAS[t].safeParse(value).success).toBe(false);
    expect(claimSchema.safeParse({ claimType: t, value }).success).toBe(false);
  });

  it('rejects a value under the wrong claim type and an unknown claim type', () => {
    expect(claimSchema.safeParse({ claimType: 'skill', value: VALID['location.current'] }).success).toBe(
      false,
    );
    expect(claimSchema.safeParse({ claimType: 'date_of_birth', value: {} }).success).toBe(false);
  });

  it('"present" keeps its asOf and never means "today"', () => {
    const v = parseClaimValue('experience.role', VALID['experience.role']);
    expect(v.end).toEqual({ open: true, asOf: new Date('2024-01-15T00:00:00.000Z') });
  });

  it.each(CLAIM_TYPES)('%s has no protected-characteristic field', (t) => {
    const fields = schemaFieldNames(CLAIM_VALUE_SCHEMAS[t]);
    for (const f of PROTECTED_FIELDS) expect(fields.has(f), `${t}.${f}`).toBe(false);
  });
});
