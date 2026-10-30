import { describe, expect, it } from 'vitest';
import {
  atsExternalId,
  EXTERNAL_ID_NAMESPACES,
  idsContradict,
  isKnownExternalIdNamespace,
  isRegisterIdNamespace,
  normalizeExternalId,
} from './external-ids';

describe('external-id namespace registry', () => {
  it.each(Object.entries(EXTERNAL_ID_NAMESPACES))('%s accepts its own example', (ns, d) => {
    const example = d.example.split(' or ')[0]!;
    expect(normalizeExternalId(ns, example)).toEqual({ id: d.normalize(example) });
  });

  it.each([
    ['gb_companies_house', ' 445790 ', '00445790'],
    ['gb_companies_house', 'sc123456', 'SC123456'],
    ['ie_cro', '0012345', '12345'],
    ['lei', '5493 001K JTII GC8Y 1R12', '5493001KJTIIGC8Y1R12'],
    ['fr_siren', '552 100 554', '552100554'],
    ['us_ein', '123456789', '12-3456789'],
    ['wikidata', 'q95', 'Q95'],
  ])('%s normalises %j to %j', (ns, raw, id) => {
    expect(normalizeExternalId(ns, raw)).toEqual({ id });
  });

  it.each([
    ['gb_companies_house', '123456789'],
    ['gb_companies_house', 'ABC12345'],
    ['lei', '5493001KJTIIGC8Y1R13'], // wrong check digits
    ['fr_siren', '552100555'], // fails Luhn
    ['duns', '12345678'],
    ['nl_kvk', '1234567'],
    ['wikidata', 'Q0'],
  ])('%s refuses %j', (ns, raw) => {
    expect(normalizeExternalId(ns, raw)).toEqual({ error: 'invalid_format' });
  });

  it('an unknown namespace is never accepted (the registry is an allowlist)', () => {
    expect(normalizeExternalId('acme_internal', '42')).toEqual({ error: 'unknown_namespace' });
    expect(isKnownExternalIdNamespace('uk_sponsor_register')).toBe(false);
    expect(isKnownExternalIdNamespace('toString')).toBe(false);
  });
});

describe('ats namespace (OPS-1b)', () => {
  it('keys a board by its source key (region included), lowercased', () => {
    expect(atsExternalId('greenhouse:AcmeCorp')).toEqual({ namespace: 'ats', id: 'greenhouse:acmecorp' });
    expect(atsExternalId('greenhouse:eu:Acme')).toEqual({ namespace: 'ats', id: 'greenhouse:eu:acme' });
    expect(normalizeExternalId('ats', ' Lever:Acme.Jobs ')).toEqual({ id: 'lever:acme.jobs' });
    expect(normalizeExternalId('ats', 'lever:eu:acme')).toEqual({ id: 'lever:eu:acme' });
    // Ashby serves board names with spaces (checked live, OPS-1b repair).
    expect(normalizeExternalId('ats', 'ashby:BlackPoint Cyber')).toEqual({ id: 'ashby:blackpoint cyber' });
  });

  it.each([
    'workday:acme',
    'greenhouse:',
    'greenhouse:eu:',
    'acme',
    'ashby:acme  corp',
    'ashby: acme',
    'lever:-acme',
  ])('refuses %j', (raw) => {
    expect(normalizeExternalId('ats', raw)).toEqual({ error: 'invalid_format' });
  });

  it('is identity evidence, not a register id, and a company may hold several boards', () => {
    expect(isKnownExternalIdNamespace('ats')).toBe(true);
    expect(isRegisterIdNamespace('ats')).toBe(false);
    expect(isRegisterIdNamespace('gb_companies_house')).toBe(true);
    expect(idsContradict({ namespace: 'ats', id: 'greenhouse:a' }, { namespace: 'ats', id: 'lever:b' })).toBe(
      false,
    );
  });
});
