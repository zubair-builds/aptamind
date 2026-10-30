import { describe, expect, it } from 'vitest';
import { interpretTitle, normalizeTitle } from './title';

describe('normalizeTitle', () => {
  it.each([
    ['Sr. Software Engineer (Remote - US)', 'Senior Software Engineer'],
    ['Senior Backend Engineer | London', 'Senior Backend Engineer'],
    ['Softwareentwickler Backend (m/w/d)', 'Softwareentwickler Backend'],
    ['Software Engineer - Backend', 'Software Engineer - Backend'],
    ['Jr Frontend Dev [Hybrid]', 'Junior Frontend Developer'],
    ['Staff Engineer – Remote', 'Staff Engineer'],
    ['  Data   Engineer  ', 'Data Engineer'],
    ['Backend Engineer (Java)', 'Backend Engineer (Java)'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });
});

describe('interpretTitle', () => {
  it('classifies family, specialisation, seniority and department', () => {
    const t = interpretTitle('Senior Full-Stack Engineer (Remote)');
    expect(t.value).toEqual({
      original: 'Senior Full-Stack Engineer (Remote)',
      normalized: 'Senior Full-Stack Engineer',
      roleFamily: 'software_engineering',
      specialization: 'fullstack',
      seniority: 'senior',
      department: 'engineering',
    });
    expect(t.confidence).toBe('high');
    expect(t.evidence[0]?.quote).toBe('Senior Full-Stack Engineer (Remote)');
  });

  it('prefers the provider department', () => {
    const t = interpretTitle('Product Manager', 'Product & Growth');
    expect(t.value.department).toBe('Product & Growth');
    expect(t.value.seniority).toBe('unclear');
    expect(t.evidence.some((e) => e.field === 'provider')).toBe(true);
  });

  it('falls back to "other" for unrecognised titles and unknown for empty ones', () => {
    expect(interpretTitle('Barista').value.roleFamily).toBe('other');
    expect(interpretTitle('Barista').confidence).toBe('low');
    const empty = interpretTitle('   ');
    expect(empty.confidence).toBe('unknown');
    expect(empty.value.roleFamily).toBeNull();
    expect(empty.evidence).toEqual([]);
  });
});
