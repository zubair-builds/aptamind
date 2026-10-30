import { describe, expect, it } from 'vitest';
import { resolveCurrencyToken, currencyTokens } from './currencies';
import { currencyOfCountry } from './geo/countries';
import { classifyRoleFamily, classifySeniority, classifySpecialization } from './roles';
import { findEmploymentTypes } from './employment';
import { findSkills, normalizeSkill, SKILLS } from './skills';
import { selectNonOverlapping, isInAllCapsRun } from './text';
import { TAXONOMY_VERSION } from './index';

describe('TAXONOMY_VERSION', () => {
  it('is a stable versioned string', () => {
    expect(TAXONOMY_VERSION).toBe('2026-09-27.1');
  });
});

describe('currencies', () => {
  it('resolves codes, symbols and words', () => {
    expect(resolveCurrencyToken('£').code).toBe('GBP');
    expect(resolveCurrencyToken('gbp').code).toBe('GBP');
    expect(resolveCurrencyToken('€').code).toBe('EUR');
    expect(resolveCurrencyToken('euros').code).toBe('EUR');
    expect(resolveCurrencyToken('AED').code).toBe('AED');
    expect(resolveCurrencyToken('dirham').code).toBe('AED');
    expect(resolveCurrencyToken('C$').code).toBe('CAD');
    expect(resolveCurrencyToken('CA$').code).toBe('CAD');
    expect(resolveCurrencyToken('A$').code).toBe('AUD');
    expect(resolveCurrencyToken('₹').code).toBe('INR');
    expect(resolveCurrencyToken('zł').code).toBe('PLN');
    expect(resolveCurrencyToken('S$').code).toBe('SGD');
  });

  it('reports ambiguous symbols with candidates', () => {
    const dollar = resolveCurrencyToken('$');
    expect(dollar.code).toBeNull();
    expect(dollar.candidates).toContain('USD');
    expect(dollar.candidates).toContain('CAD');
    expect(resolveCurrencyToken('¥').candidates).toEqual(['JPY', 'CNY']);
    expect(resolveCurrencyToken('xyz')).toEqual({ code: null, candidates: [] });
  });

  it('lists tokens longest first and maps countries to currencies', () => {
    const tokens = currencyTokens();
    expect(tokens.indexOf('CA$')).toBeLessThan(tokens.indexOf('$'));
    expect(currencyOfCountry('GB')).toBe('GBP');
    expect(currencyOfCountry('de')).toBe('EUR');
    expect(currencyOfCountry('ZZ')).toBeNull();
  });
});

describe('roles', () => {
  it.each([
    ['Senior Software Engineer', 'software_engineering', 'senior'],
    ['Staff Backend Engineer', 'software_engineering', 'staff'],
    ['Engineering Manager, Payments', 'engineering_management', 'manager'],
    ['Senior Product Manager', 'product_management', 'senior'],
    ['Product Designer', 'design', null],
    ['Product Marketing Manager', 'marketing', 'manager'],
    ['Machine Learning Engineer', 'data_science_ml', null],
    ['Data Engineer II', 'data_engineering', null],
    ['Site Reliability Engineer (SRE)', 'devops_sre', null],
    ['Principal Security Engineer', 'security', 'principal'],
    ['QA Automation Engineer', 'qa_testing', null],
    ['Account Executive, Enterprise', 'sales', null],
    ['Head of People', 'hr_people', 'director'],
    ['Senior Legal Counsel', 'legal', 'senior'],
    ['VP of Engineering', 'engineering_management', 'vp'],
    ['Software Engineering Intern', 'software_engineering', 'intern'],
    ['Jr. Frontend Developer', 'software_engineering', 'junior'],
    ['Chief Technology Officer', 'engineering_management', 'executive'],
    ['Customer Success Manager', 'customer_success', null],
    ['Tech Lead, Platform', 'software_engineering', 'lead'],
  ])('%s → %s / %s', (title, family, seniority) => {
    expect(classifyRoleFamily(title)?.family).toBe(family);
    expect(classifySeniority(title)?.level ?? null).toBe(seniority);
  });

  it('treats IC "manager" titles as not people-management seniority', () => {
    expect(classifySeniority('Product Manager')).toBeNull();
    expect(classifySeniority('Account Manager')).toBeNull();
    expect(classifySeniority('Senior Engineering Manager')?.level).toBe('manager');
  });

  it('classifies specialisations', () => {
    expect(classifySpecialization('Senior Full-Stack Engineer')?.specialization).toBe('fullstack');
    expect(classifySpecialization('Frontend Engineer')?.specialization).toBe('frontend');
    expect(classifySpecialization('iOS Developer')?.specialization).toBe('mobile');
    expect(classifySpecialization('Platform Engineer')?.specialization).toBe('platform');
    expect(classifySpecialization('Embedded Software Engineer')?.specialization).toBe('embedded');
    expect(classifySpecialization('Software Engineer')).toBeNull();
  });
});

describe('employment types', () => {
  it('finds employment type keywords', () => {
    expect(findEmploymentTypes('Full-time, permanent').map((m) => m.type)).toEqual(['full_time']);
    expect(findEmploymentTypes('6-month contract, outside IR35').map((m) => m.type)).toEqual(['contract']);
    expect(findEmploymentTypes('Summer Internship').map((m) => m.type)).toEqual(['internship']);
    expect(findEmploymentTypes('Part time (20 hours per week)').map((m) => m.type)).toEqual(['part_time']);
    expect(findEmploymentTypes('We value teamwork')).toEqual([]);
  });
});

describe('skills', () => {
  it('normalises aliases', () => {
    expect(normalizeSkill('k8s')).toBe('kubernetes');
    expect(normalizeSkill('golang')).toBe('go');
    expect(normalizeSkill('postgres')).toBe('postgresql');
    expect(normalizeSkill('PostgreSQL')).toBe('postgresql');
    expect(normalizeSkill('JS')).toBe('javascript');
    expect(normalizeSkill('TS')).toBe('typescript');
    expect(normalizeSkill('react.js')).toBe('react');
    expect(normalizeSkill('ReactJS')).toBe('react');
    expect(normalizeSkill('C++')).toBe('cpp');
    expect(normalizeSkill('C#')).toBe('csharp');
    expect(normalizeSkill('unknown thing')).toBeNull();
  });

  it('finds skills in text without common-word false positives', () => {
    const concepts = (t: string) => findSkills(t).map((m) => m.concept);
    expect(concepts('Experience with Python, Go and Kubernetes (k8s) on AWS')).toEqual([
      'python',
      'go',
      'kubernetes',
      'kubernetes',
      'aws',
    ]);
    expect(concepts('You will go to market and react quickly')).toEqual([]);
    expect(concepts('C-level stakeholders and R&D teams')).toEqual([]);
    expect(concepts('Strong C++ and C# skills')).toEqual(['cpp', 'csharp']);
    expect(concepts('JavaScript not Java')).toEqual(['javascript', 'java']);
    expect(concepts('Series C startup')).toEqual([]);
    expect(concepts('Node.js and React.js')).toEqual(['nodejs', 'react']);
  });

  it('has roughly 150 unique concepts', () => {
    const conceptsSet = new Set(SKILLS.map((s) => s.concept));
    expect(conceptsSet.size).toBe(SKILLS.length);
    expect(SKILLS.length).toBeGreaterThanOrEqual(140);
  });
});

describe('text helpers', () => {
  it('selects non-overlapping longest matches', () => {
    const out = selectNonOverlapping([
      { matchedText: 'Ireland', index: 9 },
      { matchedText: 'Northern Ireland', index: 0 },
      { matchedText: 'UK', index: 20 },
    ]);
    expect(out.map((m) => m.matchedText)).toEqual(['Northern Ireland', 'UK']);
  });

  it('detects all-caps headings', () => {
    expect(isInAllCapsRun('JOIN US', 5, 2)).toBe(true);
    expect(isInAllCapsRun('Remote - US', 9, 2)).toBe(false);
    expect(isInAllCapsRun('US & Canada', 0, 2)).toBe(false);
  });
});
