import { describe, expect, it } from 'vitest';
import { interpretAuthorization } from './authorization';

describe('interpretAuthorization', () => {
  it.each([
    ['You must have the right to work in the UK.', ['GB'], []],
    ['Applicants must be authorized to work in the United States.', ['US'], []],
    ['Must be legally eligible to work in Canada without sponsorship.', ['CA'], []],
    ['You must hold active SC clearance.', [], ['security_clearance']],
    ['Must be a US citizen with an active TS/SCI clearance.', ['US'], ['security_clearance', 'citizenship']],
    ['Permanent residents of Australia only.', ['AU'], ['permanent_residency']],
  ])('%s', (text, countries, qualifiers) => {
    const r = interpretAuthorization(text);
    expect(r.value.required).toBe(true);
    expect(r.value.countries).toEqual(countries);
    expect(r.value.qualifiers.sort()).toEqual([...qualifiers].sort());
    expect(r.evidence[0]?.quote).toBe(text);
    expect(r.confidence).not.toBe('unknown');
  });

  it('treats "without the need for sponsorship" as an authorization requirement', () => {
    const r = interpretAuthorization(
      'Candidates must be able to work in Ireland without the need for visa sponsorship.',
    );
    expect(r.value).toEqual({ required: true, countries: ['IE'], regions: [], qualifiers: [] });
  });

  it('stays unknown when nothing is said', () => {
    expect(interpretAuthorization('We offer great benefits and a friendly team.')).toEqual({
      value: { required: null, countries: [], regions: [], qualifiers: [] },
      confidence: 'unknown',
      evidence: [],
      basis: 'none',
    });
  });

  it('ignores mentions that are not requirements', () => {
    expect(
      interpretAuthorization('Our product helps HR teams track right to work checks.').value.required,
    ).toBeNull();
  });

  it.each([
    'Candidates must not require sponsorship now or in the future.',
    'You will not need visa sponsorship now or in the future.',
    'Applicants must not currently require employer sponsorship.',
    'There is no current or future need for sponsorship.',
  ])('M11.1: "%s" is an existing-authorization requirement', (text) => {
    expect(interpretAuthorization(text).value.required).toBe(true);
  });

  it('M11.1: a region-level requirement keeps the region and invents no country', () => {
    expect(interpretAuthorization('You must be eligible to work in an EU country.').value).toEqual({
      required: true,
      countries: [],
      regions: ['EU'],
      qualifiers: [],
    });
  });

  it('"candidates who require sponsorship are welcome" is not a requirement', () => {
    expect(
      interpretAuthorization('Candidates who require visa sponsorship are welcome to apply.').value.required,
    ).toBeNull();
  });
});

describe('PR #21 L7: authorization regions are taxonomy codes', () => {
  it('the contract rejects an unknown region code', async () => {
    const { authorizationSchema } = await import('../contracts/employment');
    expect(
      authorizationSchema.safeParse({ required: true, countries: [], regions: ['EU'], qualifiers: [] })
        .success,
    ).toBe(true);
    expect(
      authorizationSchema.safeParse({ required: true, countries: [], regions: ['MARS'], qualifiers: [] })
        .success,
    ).toBe(false);
  });
});
