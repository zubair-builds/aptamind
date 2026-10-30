/**
 * Hiring regions with explicit member countries. Regions are composable (EMEA = Europe + MENA +
 * sub-Saharan markets) and deliberately limited to the country set in `countries.ts`.
 */

export interface RegionDef {
  code: string;
  name: string;
  members: readonly string[];
  aliases: readonly string[];
  caseSensitiveAliases: readonly string[];
}

const EU = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
];
const EEA = [...EU, 'IS', 'LI', 'NO'];
const EUROPE = [...EEA, 'GB', 'CH', 'UA', 'RS', 'BA', 'AL', 'MK', 'MD'];
const GCC = ['AE', 'SA', 'QA', 'KW', 'BH', 'OM'];
const MENA = [...GCC, 'LB', 'IL', 'EG', 'MA', 'TN', 'TR'];
const SUB_SAHARAN = ['ZA', 'NG', 'KE', 'GH'];
const NORTH_AMERICA = ['US', 'CA', 'MX'];
const LATAM = [
  'MX',
  'BR',
  'AR',
  'CL',
  'CO',
  'PE',
  'UY',
  'CR',
  'EC',
  'VE',
  'GT',
  'PA',
  'DO',
  'BO',
  'PY',
  'PR',
];
const APAC = [
  'AU',
  'NZ',
  'IN',
  'SG',
  'JP',
  'KR',
  'CN',
  'HK',
  'TW',
  'PH',
  'ID',
  'MY',
  'TH',
  'VN',
  'PK',
  'BD',
  'LK',
];

function r(code: string, name: string, members: string[], aliases: string[], cs: string[] = []): RegionDef {
  return { code, name, members: [...new Set(members)], aliases, caseSensitiveAliases: cs };
}

export const REGIONS: readonly RegionDef[] = [
  r('EU', 'European Union', EU, ['European Union'], ['EU']),
  r('EEA', 'European Economic Area', EEA, ['European Economic Area'], ['EEA']),
  r('EUROPE', 'Europe', EUROPE, [
    'Europe',
    'European',
    'Continental Europe',
    'Western Europe',
    'Europe-based',
  ]),
  r('UK_IE', 'UK & Ireland', ['GB', 'IE'], ['UK&I'], ['UKI']),
  r('EMEA', 'Europe, Middle East & Africa', [...EUROPE, ...MENA, ...SUB_SAHARAN], ['EMEA']),
  r('NORTH_AMERICA', 'North America', NORTH_AMERICA, ['North America', 'North American'], ['NORAM', 'NAMER']),
  r('LATAM', 'Latin America', LATAM, [
    'LATAM',
    'Latin America',
    'Latin American',
    'South America',
    'South American',
    'Central America',
  ]),
  r('AMERICAS', 'Americas', [...NORTH_AMERICA, ...LATAM], ['the Americas', 'Americas'], ['AMER']),
  r('APAC', 'Asia-Pacific', APAC, ['APAC', 'Asia-Pacific', 'Asia Pacific', 'Asia'], ['APJ']),
  r('MENA', 'Middle East & North Africa', MENA, [
    'MENA',
    'Middle East',
    'Middle East and North Africa',
    'Middle East & North Africa',
    'North Africa',
  ]),
  r('GCC', 'Gulf Cooperation Council', GCC, [
    'GCC',
    'Gulf Cooperation Council',
    'Gulf region',
    'Gulf states',
    'Gulf countries',
    'Arabian Gulf',
  ]),
  r('DACH', 'Germany, Austria & Switzerland', ['DE', 'AT', 'CH'], ['DACH']),
  r(
    'NORDICS',
    'Nordics',
    ['DK', 'SE', 'NO', 'FI', 'IS'],
    ['Nordics', 'Nordic', 'Nordic countries', 'Nordic region', 'Scandinavia', 'Scandinavian'],
  ),
  r(
    'CEE',
    'Central & Eastern Europe',
    ['PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'HR', 'SI', 'EE', 'LV', 'LT', 'RS', 'UA', 'BA', 'AL', 'MK', 'MD'],
    ['CEE', 'Central and Eastern Europe', 'Central & Eastern Europe', 'Eastern Europe', 'Central Europe'],
  ),
  r('BENELUX', 'Benelux', ['BE', 'NL', 'LU'], ['Benelux']),
];

const BY_CODE = new Map(REGIONS.map((reg) => [reg.code, reg]));

export const REGION_CODES: readonly string[] = REGIONS.map((reg) => reg.code);

export function getRegion(code: string): RegionDef | undefined {
  return BY_CODE.get(code.toUpperCase());
}

/** Member countries of a region (empty for unknown codes). */
export function countriesOfRegion(region: string): readonly string[] {
  return BY_CODE.get(region.toUpperCase())?.members ?? [];
}

/** True when the ISO country is a member of the region. */
export function regionContains(region: string, country: string): boolean {
  return countriesOfRegion(region).includes(country.toUpperCase());
}
