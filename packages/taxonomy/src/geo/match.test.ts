import { describe, expect, it } from 'vitest';
import {
  findCountries,
  findPlaces,
  findRegions,
  lookupPlace,
  lookupSubdivisionCode,
  normalizeCountry,
} from './match';
import { countriesOfRegion, regionContains } from './regions';
import { COUNTRIES } from './countries';
import { REGIONS } from './regions';

const codes = (text: string) => findCountries(text).map((m) => m.code);
const regions = (text: string) => findRegions(text).map((m) => m.code);

describe('findCountries', () => {
  it('matches names, aliases and demonyms with offsets', () => {
    const text = 'Open to candidates in the United States and Canada.';
    const found = findCountries(text);
    expect(found.map((m) => m.code)).toEqual(['US', 'CA']);
    const us = found[0];
    expect(us && text.slice(us.index, us.index + us.matchedText.length)).toBe('United States');
  });

  it('recognises US/UK/UAE short forms', () => {
    expect(codes('Remote - US')).toEqual(['US']);
    expect(codes('must live in the U.S.')).toEqual(['US']);
    expect(codes('USA only')).toEqual(['US']);
    expect(codes('US-based candidates')).toEqual(['US']);
    expect(codes('based in the UK or Great Britain')).toEqual(['GB', 'GB']);
    expect(codes('UAE residents')).toEqual(['AE']);
    expect(codes('Scotland or England')).toEqual(['GB', 'GB']);
    expect(codes('Deutschland')).toEqual(['DE']);
  });

  it('does not treat prepositions and pronouns as countries', () => {
    expect(codes('We work in teams and believe in ownership.')).toEqual([]);
    expect(codes('Join us to build the future with us')).toEqual([]);
    expect(codes('IN THE OFFICE')).toEqual([]);
    expect(codes('JOIN US')).toEqual([]);
    expect(codes('ABOUT US\nWe build tools.')).toEqual([]);
    expect(codes('Is it for you? No, it is not.')).toEqual([]);
  });

  it('does not match inside longer words or region names', () => {
    expect(codes('Indianapolis, Indiana')).toEqual([]);
    expect(codes('Remote across North America')).toEqual([]);
    expect(codes('Latin American time zones')).toEqual([]);
  });

  it('keeps demonyms case-sensitive and ignores language mentions', () => {
    expect(codes('polish the UI')).toEqual([]);
    expect(codes('Polish engineers')).toEqual(['PL']);
    expect(codes('fluent German is required')).toEqual([]);
    expect(codes('German speaker')).toEqual([]);
    expect(codes('a German company')).toEqual(['DE']);
  });

  it('prefers the longest alias (Northern Ireland is GB)', () => {
    expect(codes('Belfast, Northern Ireland')).toEqual(['GB']);
  });
});

describe('findRegions', () => {
  it('matches common region aliases', () => {
    expect(regions('Remote (EMEA)')).toEqual(['EMEA']);
    expect(regions('anywhere in Europe')).toEqual(['EUROPE']);
    expect(regions('European Union citizens')).toEqual(['EU']);
    expect(regions('the Americas')).toEqual(['AMERICAS']);
    expect(regions('North America or LatAm')).toEqual(['NORTH_AMERICA', 'LATAM']);
    expect(regions('Asia-Pacific and the Middle East')).toEqual(['APAC', 'MENA']);
    expect(regions('DACH region')).toEqual(['DACH']);
    expect(regions('Central and Eastern Europe')).toEqual(['CEE']);
  });

  it('keeps EU case-sensitive', () => {
    expect(regions('EU only')).toEqual(['EU']);
    expect(regions('reu eu')).toEqual([]);
  });
});

describe('normalizeCountry', () => {
  it.each([
    ['USA', 'US'],
    ['U.S.', 'US'],
    ['United States of America', 'US'],
    ['uk', 'GB'],
    ['UK', 'GB'],
    ['Great Britain', 'GB'],
    ['England', 'GB'],
    ['UAE', 'AE'],
    ['Deutschland', 'DE'],
    ['de', 'DE'],
    ['the Netherlands', 'NL'],
    ['Holland', 'NL'],
    ['Türkiye', 'TR'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeCountry(input)).toBe(expected);
  });

  it('returns null for unknown or multi-country strings', () => {
    expect(normalizeCountry('Atlantis')).toBeNull();
    expect(normalizeCountry('')).toBeNull();
    expect(normalizeCountry('XX')).toBeNull();
    expect(normalizeCountry('US and Canada')).toBeNull();
  });
});

describe('places', () => {
  it('maps cities and states to countries', () => {
    expect(lookupPlace('london')).toMatchObject({ kind: 'city', country: 'GB' });
    expect(lookupPlace('San Francisco')).toMatchObject({ country: 'US', subdivision: 'CA' });
    expect(lookupPlace('Bengaluru')).toMatchObject({ name: 'Bangalore', country: 'IN' });
    expect(lookupPlace('Ontario')).toMatchObject({ kind: 'subdivision', country: 'CA' });
    expect(lookupPlace('Nowhere')).toBeNull();
  });

  it('finds capitalised places in free text; Georgia resolves to the US state', () => {
    const found = findPlaces('Offices in Atlanta, Georgia and Berlin.');
    expect(found.map((p) => [p.name, p.country])).toEqual([
      ['Atlanta', 'US'],
      ['Georgia', 'US'],
      ['Berlin', 'DE'],
    ]);
    expect(findPlaces('reading and writing')).toEqual([]);
  });

  it('resolves postal abbreviations with a country hint', () => {
    expect(lookupSubdivisionCode('CA', 'US')).toMatchObject({ name: 'California' });
    expect(lookupSubdivisionCode('ON')).toMatchObject({ country: 'CA', name: 'Ontario' });
    expect(lookupSubdivisionCode('ZZ')).toBeNull();
  });
});

describe('regions', () => {
  it('contains expected members', () => {
    expect(regionContains('EU', 'DE')).toBe(true);
    expect(regionContains('EU', 'GB')).toBe(false);
    expect(regionContains('EUROPE', 'GB')).toBe(true);
    expect(regionContains('EMEA', 'AE')).toBe(true);
    expect(regionContains('EMEA', 'ZA')).toBe(true);
    expect(regionContains('EEA', 'NO')).toBe(true);
    expect(regionContains('GCC', 'SA')).toBe(true);
    expect(regionContains('NORDICS', 'IS')).toBe(true);
    expect(regionContains('LATAM', 'BR')).toBe(true);
    expect(regionContains('APAC', 'SG')).toBe(true);
    expect(countriesOfRegion('UNKNOWN')).toEqual([]);
    expect(countriesOfRegion('eu')).toHaveLength(27);
  });

  it('only references countries that exist in the taxonomy', () => {
    const known = new Set(COUNTRIES.map((c) => c.code));
    for (const region of REGIONS) {
      for (const member of region.members) expect(known.has(member), `${region.code}:${member}`).toBe(true);
    }
  });

  it('covers every required market', () => {
    const required =
      'GB US CA MX BR AR CL CO AU NZ IN SG JP KR CN HK PH ID MY TH VN AE SA QA IL TR ZA NG KE EG MA PK UA CH NO IS RS'.split(
        ' ',
      );
    const known = new Set(COUNTRIES.map((c) => c.code));
    for (const code of [...required, ...countriesOfRegion('EEA')]) expect(known.has(code), code).toBe(true);
  });
});
