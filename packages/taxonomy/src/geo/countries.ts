/**
 * Country taxonomy (ISO 3166-1 alpha-2) with the aliases and demonyms that actually appear in job
 * text. Aliases are case-insensitive unless listed in `caseSensitiveAliases` (short tokens such as
 * `US`/`UK` that collide with ordinary words). Demonyms/adjectives are always case-sensitive
 * (proper adjectives are capitalised; this keeps "polish the UI" from matching Poland).
 */

export interface CountryDef {
  code: string;
  name: string;
  /** Case-insensitive alternative names. */
  aliases: readonly string[];
  /** Case-sensitive tokens (abbreviations that collide with common words when lower-cased). */
  caseSensitiveAliases: readonly string[];
  /** Demonyms/adjectives useful in job text ("US-based", "British"). Case-sensitive. */
  adjectives: readonly string[];
  /** ISO 4217 code of the main currency. */
  currency: string;
  /** Representative UTC offset range in hours (standard time), inclusive. */
  utcOffsets: readonly [number, number];
}

function c(
  code: string,
  name: string,
  currency: string,
  utcOffsets: readonly [number, number],
  opts: { aliases?: string[]; cs?: string[]; adj?: string[] } = {},
): CountryDef {
  return {
    code,
    name,
    currency,
    utcOffsets,
    aliases: opts.aliases ?? [],
    caseSensitiveAliases: opts.cs ?? [],
    adjectives: opts.adj ?? [],
  };
}

export const COUNTRIES: readonly CountryDef[] = [
  // --- EU member states ---
  c('AT', 'Austria', 'EUR', [1, 1], { aliases: ['Österreich', 'Osterreich'], adj: ['Austrian'] }),
  c('BE', 'Belgium', 'EUR', [1, 1], { aliases: ['België', 'Belgique'], adj: ['Belgian'] }),
  c('BG', 'Bulgaria', 'BGN', [2, 2], { adj: ['Bulgarian'] }),
  c('HR', 'Croatia', 'EUR', [1, 1], { aliases: ['Hrvatska'], adj: ['Croatian'] }),
  c('CY', 'Cyprus', 'EUR', [2, 2], { adj: ['Cypriot'] }),
  c('CZ', 'Czechia', 'CZK', [1, 1], { aliases: ['Czech Republic'], adj: ['Czech'] }),
  c('DK', 'Denmark', 'DKK', [1, 1], { aliases: ['Danmark'], adj: ['Danish'] }),
  c('EE', 'Estonia', 'EUR', [2, 2], { adj: ['Estonian'] }),
  c('FI', 'Finland', 'EUR', [2, 2], { aliases: ['Suomi'], adj: ['Finnish'] }),
  c('FR', 'France', 'EUR', [1, 1], { adj: ['French'] }),
  c('DE', 'Germany', 'EUR', [1, 1], { aliases: ['Deutschland'], adj: ['German'] }),
  c('GR', 'Greece', 'EUR', [2, 2], { aliases: ['Hellas'], adj: ['Greek'] }),
  c('HU', 'Hungary', 'HUF', [1, 1], { aliases: ['Magyarország'], adj: ['Hungarian'] }),
  c('IE', 'Ireland', 'EUR', [0, 0], { aliases: ['Republic of Ireland', 'Éire', 'Eire'], adj: ['Irish'] }),
  c('IT', 'Italy', 'EUR', [1, 1], { aliases: ['Italia'], adj: ['Italian'] }),
  c('LV', 'Latvia', 'EUR', [2, 2], { adj: ['Latvian'] }),
  c('LT', 'Lithuania', 'EUR', [2, 2], { adj: ['Lithuanian'] }),
  c('LU', 'Luxembourg', 'EUR', [1, 1], { adj: ['Luxembourgish'] }),
  c('MT', 'Malta', 'EUR', [1, 1], { adj: ['Maltese'] }),
  c('NL', 'Netherlands', 'EUR', [1, 1], {
    aliases: ['The Netherlands', 'Holland', 'Nederland'],
    adj: ['Dutch'],
  }),
  c('PL', 'Poland', 'PLN', [1, 1], { aliases: ['Polska'], adj: ['Polish'] }),
  c('PT', 'Portugal', 'EUR', [-1, 0], { adj: ['Portuguese'] }),
  c('RO', 'Romania', 'RON', [2, 2], { aliases: ['România'], adj: ['Romanian'] }),
  c('SK', 'Slovakia', 'EUR', [1, 1], { aliases: ['Slovak Republic'], adj: ['Slovak', 'Slovakian'] }),
  c('SI', 'Slovenia', 'EUR', [1, 1], { adj: ['Slovenian', 'Slovene'] }),
  c('ES', 'Spain', 'EUR', [0, 1], { aliases: ['España', 'Espana'], adj: ['Spanish'] }),
  c('SE', 'Sweden', 'SEK', [1, 1], { aliases: ['Sverige'], adj: ['Swedish'] }),
  // --- Rest of EEA / wider Europe ---
  c('IS', 'Iceland', 'ISK', [0, 0], { adj: ['Icelandic'] }),
  c('LI', 'Liechtenstein', 'CHF', [1, 1]),
  c('NO', 'Norway', 'NOK', [1, 1], { aliases: ['Norge'], adj: ['Norwegian'] }),
  c('CH', 'Switzerland', 'CHF', [1, 1], { aliases: ['Schweiz', 'Suisse', 'Svizzera'], adj: ['Swiss'] }),
  c('GB', 'United Kingdom', 'GBP', [0, 0], {
    aliases: ['U.K.', 'Great Britain', 'Britain', 'England', 'Scotland', 'Wales', 'Northern Ireland'],
    cs: ['UK', 'GB'],
    adj: ['British', 'UK-based', 'Scottish', 'Welsh'],
  }),
  c('UA', 'Ukraine', 'UAH', [2, 2], { adj: ['Ukrainian'] }),
  c('RS', 'Serbia', 'RSD', [1, 1], { adj: ['Serbian'] }),
  c('BA', 'Bosnia and Herzegovina', 'BAM', [1, 1], { aliases: ['Bosnia'], adj: ['Bosnian'] }),
  c('AL', 'Albania', 'ALL', [1, 1], { adj: ['Albanian'] }),
  c('MK', 'North Macedonia', 'MKD', [1, 1], { aliases: ['Macedonia'], adj: ['Macedonian'] }),
  c('MD', 'Moldova', 'MDL', [2, 2], { adj: ['Moldovan'] }),
  c('TR', 'Türkiye', 'TRY', [3, 3], { aliases: ['Turkiye'], cs: ['Turkey'], adj: ['Turkish'] }),
  c('RU', 'Russia', 'RUB', [2, 12], { aliases: ['Russian Federation'], adj: ['Russian'] }),
  // --- Americas ---
  c('US', 'United States', 'USD', [-10, -5], {
    aliases: ['United States of America', 'U.S.', 'U.S.A.', 'USA', 'U.S.A'],
    cs: ['US'],
    adj: ['American', 'US-based', 'U.S.-based', 'USA-based'],
  }),
  c('CA', 'Canada', 'CAD', [-8, -3.5], { adj: ['Canadian', 'Canada-based'] }),
  c('MX', 'Mexico', 'MXN', [-8, -5], { aliases: ['México'], adj: ['Mexican'] }),
  c('BR', 'Brazil', 'BRL', [-5, -2], { aliases: ['Brasil'], adj: ['Brazilian'] }),
  c('AR', 'Argentina', 'ARS', [-3, -3], { adj: ['Argentine', 'Argentinian'] }),
  c('CL', 'Chile', 'CLP', [-4, -3], { adj: ['Chilean'] }),
  c('CO', 'Colombia', 'COP', [-5, -5], { adj: ['Colombian'] }),
  c('PE', 'Peru', 'PEN', [-5, -5], { aliases: ['Perú'], adj: ['Peruvian'] }),
  c('UY', 'Uruguay', 'UYU', [-3, -3], { adj: ['Uruguayan'] }),
  c('CR', 'Costa Rica', 'CRC', [-6, -6], { adj: ['Costa Rican'] }),
  c('EC', 'Ecuador', 'USD', [-5, -5], { adj: ['Ecuadorian'] }),
  c('VE', 'Venezuela', 'VES', [-4, -4], { adj: ['Venezuelan'] }),
  c('GT', 'Guatemala', 'GTQ', [-6, -6], { adj: ['Guatemalan'] }),
  c('PA', 'Panama', 'PAB', [-5, -5], { aliases: ['Panamá'], adj: ['Panamanian'] }),
  c('DO', 'Dominican Republic', 'DOP', [-4, -4], { adj: ['Dominican'] }),
  c('BO', 'Bolivia', 'BOB', [-4, -4], { adj: ['Bolivian'] }),
  c('PY', 'Paraguay', 'PYG', [-4, -3], { adj: ['Paraguayan'] }),
  c('PR', 'Puerto Rico', 'USD', [-4, -4], { adj: ['Puerto Rican'] }),
  // --- Asia-Pacific ---
  c('AU', 'Australia', 'AUD', [8, 10.5], { adj: ['Australian'] }),
  c('NZ', 'New Zealand', 'NZD', [12, 12], {
    aliases: ['Aotearoa'],
    cs: ['NZ'],
    adj: ['New Zealander', 'Kiwi'],
  }),
  c('IN', 'India', 'INR', [5.5, 5.5], { aliases: ['Bharat'], adj: ['Indian'] }),
  c('SG', 'Singapore', 'SGD', [8, 8], { adj: ['Singaporean'] }),
  c('JP', 'Japan', 'JPY', [9, 9], { aliases: ['Nippon'], adj: ['Japanese'] }),
  c('KR', 'South Korea', 'KRW', [9, 9], {
    aliases: ['Korea', 'Republic of Korea'],
    adj: ['Korean', 'South Korean'],
  }),
  c('CN', 'China', 'CNY', [8, 8], {
    aliases: ["People's Republic of China", 'Mainland China', 'PRC'],
    adj: ['Chinese'],
  }),
  c('HK', 'Hong Kong', 'HKD', [8, 8], { aliases: ['Hong Kong SAR'], cs: ['HK'] }),
  c('TW', 'Taiwan', 'TWD', [8, 8], { adj: ['Taiwanese'] }),
  c('PH', 'Philippines', 'PHP', [8, 8], { aliases: ['The Philippines'], adj: ['Filipino', 'Philippine'] }),
  c('ID', 'Indonesia', 'IDR', [7, 9], { adj: ['Indonesian'] }),
  c('MY', 'Malaysia', 'MYR', [8, 8], { adj: ['Malaysian'] }),
  c('TH', 'Thailand', 'THB', [7, 7], { adj: ['Thai'] }),
  c('VN', 'Vietnam', 'VND', [7, 7], { aliases: ['Viet Nam'], adj: ['Vietnamese'] }),
  c('PK', 'Pakistan', 'PKR', [5, 5], { adj: ['Pakistani'] }),
  c('BD', 'Bangladesh', 'BDT', [6, 6], { adj: ['Bangladeshi'] }),
  c('LK', 'Sri Lanka', 'LKR', [5.5, 5.5], { adj: ['Sri Lankan'] }),
  // --- Middle East & Africa ---
  c('AE', 'United Arab Emirates', 'AED', [4, 4], {
    aliases: ['U.A.E.', 'Emirates'],
    cs: ['UAE'],
    adj: ['Emirati', 'UAE-based'],
  }),
  c('SA', 'Saudi Arabia', 'SAR', [3, 3], {
    aliases: ['Kingdom of Saudi Arabia'],
    cs: ['KSA'],
    adj: ['Saudi'],
  }),
  c('QA', 'Qatar', 'QAR', [3, 3], { adj: ['Qatari'] }),
  c('KW', 'Kuwait', 'KWD', [3, 3], { adj: ['Kuwaiti'] }),
  c('BH', 'Bahrain', 'BHD', [3, 3], { adj: ['Bahraini'] }),
  c('OM', 'Oman', 'OMR', [4, 4], { adj: ['Omani'] }),
  c('LB', 'Lebanon', 'LBP', [2, 2], { adj: ['Lebanese'] }),
  c('IL', 'Israel', 'ILS', [2, 2], { adj: ['Israeli'] }),
  c('EG', 'Egypt', 'EGP', [2, 2], { adj: ['Egyptian'] }),
  c('MA', 'Morocco', 'MAD', [0, 1], { adj: ['Moroccan'] }),
  c('TN', 'Tunisia', 'TND', [1, 1], { adj: ['Tunisian'] }),
  c('ZA', 'South Africa', 'ZAR', [2, 2], { adj: ['South African'] }),
  c('NG', 'Nigeria', 'NGN', [1, 1], { adj: ['Nigerian'] }),
  c('KE', 'Kenya', 'KES', [3, 3], { adj: ['Kenyan'] }),
  c('GH', 'Ghana', 'GHS', [0, 0], { adj: ['Ghanaian'] }),
];

const BY_CODE = new Map(COUNTRIES.map((ct) => [ct.code, ct]));

/** All known ISO alpha-2 codes in the taxonomy. */
export const COUNTRY_CODES: readonly string[] = COUNTRIES.map((ct) => ct.code);

export function getCountry(code: string): CountryDef | undefined {
  return BY_CODE.get(code.toUpperCase());
}

export function isCountryCode(code: string): boolean {
  return BY_CODE.has(code.toUpperCase());
}

/** Main ISO 4217 currency of a country, or null when not in the taxonomy. */
export function currencyOfCountry(code: string): string | null {
  return BY_CODE.get(code.toUpperCase())?.currency ?? null;
}
