import { describe, expect, it } from 'vitest';
import { annualize, findSalaryText, interpretCompensation, normalizeSalary, parseAmount } from './salary';

const pick = (text: string, countries: string[] = []) => {
  const c = normalizeSalary(text, { countries });
  return { status: c.status, min: c.min, max: c.max, currency: c.currency, period: c.period };
};

describe('parseAmount', () => {
  it.each([
    ['50,000', 50000],
    ['50000', 50000],
    ['45.000', 45000],
    ['1.234.567', 1234567],
    ['45 000', 45000],
    ['1.234,56', 1234.56],
    ['1,234.56', 1234.56],
    ['45.50', 45.5],
    ['45,5', 45.5],
  ])('%s → %s', (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });
});

describe('normalizeSalary', () => {
  it.each([
    [
      '£50,000 - £60,000 per annum',
      [],
      { status: 'parsed', min: 50000, max: 60000, currency: 'GBP', period: 'year' },
    ],
    ['$120k–$150k', ['US'], { status: 'parsed', min: 120000, max: 150000, currency: 'USD', period: 'year' }],
    ['USD 45/hr', [], { status: 'parsed', min: 45, max: 45, currency: 'USD', period: 'hour' }],
    [
      '€45.000 - €55.000 brutto/Jahr',
      [],
      { status: 'parsed', min: 45000, max: 55000, currency: 'EUR', period: 'year' },
    ],
    [
      'AED 25,000 per month',
      [],
      { status: 'parsed', min: 25000, max: 25000, currency: 'AED', period: 'month' },
    ],
    ['50-60k GBP', [], { status: 'parsed', min: 50000, max: 60000, currency: 'GBP', period: 'year' }],
    ['up to £70k', [], { status: 'parsed', min: null, max: 70000, currency: 'GBP', period: 'year' }],
    [
      'from $90,000 a year',
      ['US'],
      { status: 'parsed', min: 90000, max: null, currency: 'USD', period: 'year' },
    ],
    ['£350 - £450 per day', [], { status: 'parsed', min: 350, max: 450, currency: 'GBP', period: 'day' }],
    [
      'CA$95,000 – CA$110,000 annually',
      [],
      { status: 'parsed', min: 95000, max: 110000, currency: 'CAD', period: 'year' },
    ],
    [
      '₹25,00,000 per annum',
      [],
      { status: 'parsed', min: 2500000, max: 2500000, currency: 'INR', period: 'year' },
    ],
    [
      'CHF 120 000 – 140 000 per year',
      [],
      { status: 'parsed', min: 120000, max: 140000, currency: 'CHF', period: 'year' },
    ],
    [
      '8 000 - 12 000 zł brutto miesięcznie / month',
      [],
      { status: 'parsed', min: 8000, max: 12000, currency: 'PLN', period: 'month' },
    ],
    ['£1,200 per week', [], { status: 'parsed', min: 1200, max: 1200, currency: 'GBP', period: 'week' }],
    [
      '50,000 pounds a year',
      [],
      { status: 'parsed', min: 50000, max: 50000, currency: 'GBP', period: 'year' },
    ],
  ])('%s', (text, countries, expected) => {
    expect(pick(text, countries)).toEqual(expected);
  });

  it('keeps the original text and annualises with explicit assumptions', () => {
    const c = normalizeSalary('£350 - £450 per day');
    expect(c.originalText).toBe('£350 - £450 per day');
    expect(c.basis).toBe('contract_rate');
    expect(c.annualized).toEqual({
      min: 91000,
      max: 117000,
      assumptions: ['260 working days per year (5 days/week × 52 weeks)'],
    });
    expect(normalizeSalary('USD 45/hr').annualized).toEqual({
      min: 93600,
      max: 93600,
      assumptions: ['2080 working hours per year (40 h/week × 52 weeks)'],
    });
    expect(normalizeSalary('£4,000 per month').annualized?.assumptions).toEqual(['12 months per year']);
  });

  it('never turns vague or missing pay into zero', () => {
    for (const text of ['Competitive salary', 'Salary: TBD', 'DOE', 'Salary: negotiable']) {
      const c = normalizeSalary(text);
      expect(c.status).toBe('unknown');
      expect(c.min).toBeNull();
      expect(c.max).toBeNull();
      expect(c.originalText).toBe(text);
      expect(c.warnings).toEqual(['No numeric salary stated.']);
    }
    expect(normalizeSalary('').status).toBe('unknown');
  });

  it('marks inverted and zero ranges as malformed', () => {
    const inverted = normalizeSalary('£50,000 - £40');
    expect(inverted).toMatchObject({ status: 'malformed', min: null, max: null, period: null });
    expect(inverted.warnings.some((w) => /inverted/.test(w))).toBe(true);
    expect(normalizeSalary('Salary: £0').status).toBe('malformed');
  });

  it('treats a bare dollar sign as ambiguous outside dollar countries', () => {
    const c = normalizeSalary('$90,000 - $110,000', { countries: ['GB'] });
    expect(c).toMatchObject({ status: 'ambiguous', currency: null, min: 90000, max: 110000, period: 'year' });
    expect(c.warnings.some((w) => /ambiguous/.test(w))).toBe(true);
    expect(normalizeSalary('$90,000 - $110,000').status).toBe('ambiguous');
    expect(normalizeSalary('$90,000 - $110,000', { countries: ['US'] }).currency).toBe('USD');
    expect(normalizeSalary('$90,000 - $110,000', { countries: ['CA'] }).currency).toBe('CAD');
    expect(normalizeSalary('$90,000 - $110,000', { countries: ['US', 'CA'] }).status).toBe('ambiguous');
  });

  it('reports missing currency or period as ambiguous', () => {
    expect(normalizeSalary('Salary: 50,000 - 60,000 per year')).toMatchObject({
      status: 'ambiguous',
      currency: null,
      min: 50000,
    });
    expect(normalizeSalary('SEK 45,000')).toMatchObject({
      status: 'ambiguous',
      currency: 'SEK',
      period: null,
    });
  });

  it('detects OTE and total compensation bases', () => {
    expect(normalizeSalary('OTE £100,000').basis).toBe('ote');
    expect(normalizeSalary('Total compensation $200k - $250k', { countries: ['US'] }).basis).toBe(
      'total_compensation',
    );
    expect(normalizeSalary('Base salary £60k').basis).toBe('base_salary');
  });

  it('ignores funding amounts and benefit amounts', () => {
    expect(normalizeSalary('We raised $10M in Series A funding').status).toBe('unknown');
    expect(normalizeSalary('£1,000 learning budget').status).toBe('unknown');
  });
});

describe('findSalaryText', () => {
  it('picks the salary sentence over funding and benefit sentences', () => {
    const text = [
      'We raised $40M from top investors.',
      'Everyone gets a £1,000 learning budget.',
      'The salary for this role is £65,000 - £75,000 plus bonus.',
    ].join('\n');
    expect(findSalaryText(text)?.text).toBe('The salary for this role is £65,000 - £75,000 plus bonus.');
  });

  it('falls back to a vague salary statement', () => {
    expect(findSalaryText('We offer a competitive salary.')?.text).toBe('We offer a competitive salary.');
    expect(findSalaryText('We build tools.')).toBeNull();
  });
});

describe('interpretCompensation', () => {
  it('prefers structured provider values and warns on inconsistency', () => {
    const r = interpretCompensation({
      description: '',
      provider: {
        min: 100000,
        max: 120000,
        currency: 'usd',
        period: 'year',
        text: '$90,000 - $110,000 per year',
      },
      hints: { countries: ['US'] },
    });
    expect(r.compensation.value).toMatchObject({
      status: 'parsed',
      min: 100000,
      max: 120000,
      currency: 'USD',
      period: 'year',
    });
    expect(r.compensation.basis).toBe('provider.compensation');
    expect(r.flags.map((f) => f.code)).toEqual(['compensation_source_conflict']);
  });

  it('accepts consistent provider values without warnings', () => {
    const r = interpretCompensation({
      description: 'Salary: £50,000 - £60,000 per annum.',
      provider: { min: 50000, max: 60000, currency: 'GBP', period: 'year' },
      hints: {},
    });
    expect(r.compensation.value.warnings).toEqual([]);
    expect(r.compensation.confidence).toBe('high');
    expect(r.compensation.evidence.map((e) => e.field)).toEqual(['provider', 'description']);
  });

  it('treats provider zeros as missing', () => {
    const r = interpretCompensation({
      description: '',
      provider: { min: 0, max: 0, currency: 'GBP' },
      hints: {},
    });
    expect(r.compensation.value.status).toBe('unknown');
    expect(r.compensation.value.min).toBeNull();
  });

  it('extracts equity and bonus text', () => {
    const r = interpretCompensation({
      description: 'Salary: £80k base.\nYou will also receive stock options.\nAnnual bonus of up to 10%.',
      hints: {},
    });
    expect(r.compensation.value.equityText).toBe('You will also receive stock options.');
    expect(r.compensation.value.bonusText).toBe('Annual bonus of up to 10%.');
  });

  it('annualize returns null without a period', () => {
    expect(annualize(1, 2, null)).toBeNull();
    expect(annualize(null, null, 'year')).toBeNull();
  });
});

describe('audit M-2 regressions', () => {
  it('an explicit currency code wins over a shared symbol', () => {
    expect(normalizeSalary('$150k USD', { countries: ['GB'] })).toMatchObject({
      currency: 'USD',
      min: 150000,
    });
    expect(normalizeSalary('$120k - $150k USD', { countries: ['CA'] })).toMatchObject({
      currency: 'USD',
      min: 120000,
      max: 150000,
    });
  });

  it('"+" after a single amount is an open-ended minimum; "+ bonus" is not', () => {
    expect(normalizeSalary('£80k+', { countries: ['GB'] })).toMatchObject({ min: 80000, max: null });
    expect(normalizeSalary('£80,000+ per year', { countries: ['GB'] })).toMatchObject({
      min: 80000,
      max: null,
    });
    expect(normalizeSalary('£80k + bonus', { countries: ['GB'] })).toMatchObject({ min: 80000, max: 80000 });
    expect(normalizeSalary('£80k + equity', { countries: ['GB'] })).toMatchObject({ min: 80000, max: 80000 });
  });

  it.each([
    ['As a bonus, you have experience with Kubernetes.', null],
    ['Preferred qualifications are a bonus.', null],
    ['Bonus points if you know Go.', null],
    ['Experience with Rust would be a big bonus.', null],
    ['Salary: £60,000 plus annual bonus.', 'Salary: £60,000 plus annual bonus.'],
    ['You will be eligible for a performance bonus.', 'You will be eligible for a performance bonus.'],
    ['Bonus of up to 15% of base salary.', 'Bonus of up to 15% of base salary.'],
  ])('bonus context: %s', (description, expected) => {
    expect(
      interpretCompensation({ description, hints: { countries: ['GB'] } }).compensation.value.bonusText,
    ).toBe(expected);
  });
});
