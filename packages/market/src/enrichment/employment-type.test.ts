import { describe, expect, it } from 'vitest';
import { interpretEmploymentType } from './employment-type';

describe('interpretEmploymentType', () => {
  it('uses the provider label first', () => {
    const r = interpretEmploymentType('Engineer', '', 'Full-Time');
    expect(r.employmentType).toMatchObject({
      value: 'full_time',
      confidence: 'high',
      basis: 'provider.employmentType',
    });
  });

  it('flags a provider/description conflict', () => {
    const r = interpretEmploymentType(
      'Engineer',
      'This is a part-time position (20 hours per week).',
      'Full-time',
    );
    expect(r.employmentType.value).toBe('full_time');
    expect(r.employmentType.confidence).toBe('medium');
    expect(r.flags.map((f) => f.code)).toEqual(['employment_type_conflict']);
  });

  it('reads the title', () => {
    const r = interpretEmploymentType('Summer Engineering Intern', '');
    expect(r.employmentType).toMatchObject({ value: 'internship', basis: 'title.explicit' });
    expect(r.employmentType.evidence[0]?.quote).toBe('Intern');
  });

  it('reads explicit description statements about the role only', () => {
    const r = interpretEmploymentType(
      'Engineer',
      'We work with many contractors. This is a 6-month contract role, outside IR35.',
    );
    expect(r.employmentType).toMatchObject({ value: 'contract', basis: 'description.explicit' });
    const none = interpretEmploymentType('Engineer', 'Our customers include contractors and freelancers.');
    expect(none.employmentType).toMatchObject({ value: 'unclear', confidence: 'unknown', evidence: [] });
  });

  it('accepts compatible combinations without flags', () => {
    const r = interpretEmploymentType(
      'Engineer',
      'This is a full-time, 12-month fixed-term contract position.',
    );
    expect(r.employmentType.value).toBe('contract');
    expect(r.flags).toEqual([]);
  });
});
