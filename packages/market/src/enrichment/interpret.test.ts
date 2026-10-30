import {
  EMPLOYMENT_TYPES as TAXONOMY_EMPLOYMENT_TYPES,
  REMOTE_SCOPE_TYPES as TAXONOMY_REMOTE_SCOPE_TYPES,
  REQUIREMENT_CATEGORIES as TAXONOMY_REQUIREMENT_CATEGORIES,
  SENIORITY_LEVELS as TAXONOMY_SENIORITY_LEVELS,
  TAXONOMY_VERSION,
  WORK_MODELS as TAXONOMY_WORK_MODELS,
} from '@aptamind/taxonomy';
import { describe, expect, it } from 'vitest';
import {
  EMPLOYMENT_TYPES,
  jobInterpretationSchema,
  REMOTE_SCOPE_TYPES,
  REQUIREMENT_CATEGORIES,
  SENIORITY_LEVELS,
  WORK_MODELS,
} from '../contracts/employment';
import { checkInterpretationInvariants } from './golden';
import { htmlToText } from './html';
import { INTERPRETATION_LOGIC_VERSION, INTERPRETATION_POLICY_VERSION, interpretJob } from './interpret';

describe('taxonomy ↔ contract enums', () => {
  it('stay in sync', () => {
    expect([...TAXONOMY_SENIORITY_LEVELS]).toEqual([...SENIORITY_LEVELS]);
    expect([...TAXONOMY_EMPLOYMENT_TYPES]).toEqual([...EMPLOYMENT_TYPES]);
    expect([...TAXONOMY_REQUIREMENT_CATEGORIES]).toEqual([...REQUIREMENT_CATEGORIES]);
    expect([...TAXONOMY_WORK_MODELS]).toEqual([...WORK_MODELS]);
    expect([...TAXONOMY_REMOTE_SCOPE_TYPES]).toEqual([...REMOTE_SCOPE_TYPES]);
  });
});

describe('interpretJob', () => {
  const html = `<h2>About the role</h2>
    <p>This is a fully remote role, open to candidates in the UK and Ireland. We are unable to offer visa sponsorship.</p>
    <p>Salary: £70,000 – £85,000 per annum + equity.</p>
    <h3>What you'll need</h3>
    <ul><li>5+ years of Python</li><li>Experience with AWS is a plus</li></ul>`;
  const input = {
    title: 'Senior Python Engineer (Remote, UK)',
    descriptionText: htmlToText(html),
    locationTexts: ['Remote - UK'],
    provider: { workplaceType: 'remote' as const, employmentTypeText: 'Full-time' },
    company: { sponsorLicenceCountries: ['GB'], historicalSponsorshipCountries: [], hqCountry: 'GB' },
  };

  it('produces a schema-valid, versioned interpretation', () => {
    const out = interpretJob(input);
    expect(jobInterpretationSchema.safeParse(out).success).toBe(true);
    expect(out.logicVersion).toBe(INTERPRETATION_LOGIC_VERSION);
    expect(out.policyVersion).toBe(INTERPRETATION_POLICY_VERSION);
    expect(out.taxonomyVersion).toBe(TAXONOMY_VERSION);
    expect(checkInterpretationInvariants(input, out)).toEqual([]);
  });

  it('combines every module', () => {
    const out = interpretJob(input);
    expect(out.title.value).toMatchObject({ normalized: 'Senior Python Engineer', seniority: 'senior' });
    expect(out.employmentType.value).toBe('full_time');
    expect(out.workModel.value).toBe('remote');
    expect(out.remoteScope.value).toMatchObject({ type: 'selected_countries', countries: ['GB', 'IE'] });
    // Free-text refusal: a mention (9186ad2); the licence stays company capability.
    expect(out.sponsorship.value).toMatchObject({
      status: 'company_capable',
      roleStatement: 'none',
      companyCapability: 'licensed',
    });
    expect(out.compensation.value).toMatchObject({
      status: 'parsed',
      min: 70000,
      max: 85000,
      currency: 'GBP',
      period: 'year',
    });
    expect(out.compensation.value.equityText).toBe('Salary: £70,000 – £85,000 per annum + equity.');
    expect(out.requirements.map((r) => [r.normalizedConcept, r.importance])).toEqual([
      ['python', 'important'],
      ['aws', 'preferred'],
    ]);
    expect(out.locations).toEqual([
      { text: 'Remote - UK', city: null, region: null, country: 'GB', isRemoteLabel: true },
    ]);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(interpretJob(input))).toBe(JSON.stringify(interpretJob(input)));
  });

  it('applies input defaults and rejects invalid input', () => {
    const out = interpretJob({ title: 'Engineer', descriptionText: '' });
    expect(out.workModel.value).toBe('unclear');
    expect(out.locations).toEqual([]);
    expect(() => interpretJob({ title: 1 } as unknown as Parameters<typeof interpretJob>[0])).toThrow();
  });
});
