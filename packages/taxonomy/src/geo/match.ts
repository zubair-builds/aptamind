import { isInAllCapsRun, normalizeKey, overlapsAny, TermMatcher } from '../text';
import type { TermEntry, TermMatch } from '../text';
import { COUNTRIES, getCountry } from './countries';
import { CITIES, SUBDIVISIONS } from './places';
import { REGIONS } from './regions';

export type CountryMatchKind = 'name' | 'alias' | 'adjective';

export interface CountryMatch {
  code: string;
  matchedText: string;
  index: number;
  kind: CountryMatchKind;
}

export interface RegionMatch {
  code: string;
  matchedText: string;
  index: number;
}

export interface PlaceMatch {
  kind: 'city' | 'subdivision';
  /** Canonical city or subdivision name. */
  name: string;
  country: string;
  /** Subdivision abbreviation (for cities, the subdivision they are in when known). */
  subdivision: string | null;
  matchedText: string;
  index: number;
}

interface CountryValue {
  code: string;
  kind: CountryMatchKind;
}

const countryEntries: Array<TermEntry<CountryValue>> = COUNTRIES.flatMap((ct) => [
  { term: ct.name, value: { code: ct.code, kind: 'name' as const } },
  ...ct.aliases.map((a) => ({ term: a, value: { code: ct.code, kind: 'alias' as const } })),
  ...ct.caseSensitiveAliases.map((a) => ({
    term: a,
    value: { code: ct.code, kind: 'alias' as const },
    caseSensitive: true,
  })),
  ...ct.adjectives.map((a) => ({
    term: a,
    value: { code: ct.code, kind: 'adjective' as const },
    caseSensitive: true,
  })),
]);

const LANGUAGE_CONTEXT_BEFORE =
  /(?:fluent|fluency|native|speak|speaking|spoken|written|business|proficient|proficiency)(?:\s+in)?\s*$/i;
const LANGUAGE_CONTEXT_AFTER =
  /^\s*(?:speaker|speaking|language|fluency|skills|\(fluent|\(native|\(C1|\(B2)/i;

function rejectCountry(text: string, m: TermMatch<CountryValue>): boolean {
  // Short upper-case tokens inside shouting headings: "JOIN US", "ABOUT US".
  if (
    m.matchedText.length <= 3 &&
    /^[A-Z]+$/.test(m.matchedText) &&
    isInAllCapsRun(text, m.index, m.matchedText.length)
  ) {
    return true;
  }
  // "US" pronoun in title-case phrases such as "Contact US" is rare; the case-sensitive rule handles "us".
  if (m.value.kind === 'adjective') {
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    const after = text.slice(m.index + m.matchedText.length, m.index + m.matchedText.length + 20);
    // Demonyms double as language names: "fluent German", "German speaker".
    if (LANGUAGE_CONTEXT_BEFORE.test(before) || LANGUAGE_CONTEXT_AFTER.test(after)) return true;
  }
  return false;
}

const countryMatcher = new TermMatcher<CountryValue>(countryEntries, rejectCountry);

const regionEntries: Array<TermEntry<string>> = REGIONS.flatMap((reg) => [
  ...reg.aliases.map((a) => ({ term: a, value: reg.code })),
  ...reg.caseSensitiveAliases.map((a) => ({ term: a, value: reg.code, caseSensitive: true })),
]);

const regionMatcher = new TermMatcher<string>(regionEntries, (text, m) =>
  m.matchedText.length <= 3 && /^[A-Z]+$/.test(m.matchedText)
    ? isInAllCapsRun(text, m.index, m.matchedText.length)
    : false,
);

interface PlaceValue {
  kind: 'city' | 'subdivision';
  name: string;
  country: string;
  subdivision: string | null;
}

const placeEntries: Array<TermEntry<PlaceValue>> = [
  ...CITIES.flatMap((ct) =>
    [ct.name, ...(ct.aliases ?? [])].map((term) => ({
      term,
      value: {
        kind: 'city' as const,
        name: ct.name,
        country: ct.country,
        subdivision: ct.subdivision ?? null,
      },
      caseSensitive: true,
    })),
  ),
  ...SUBDIVISIONS.map((s) => ({
    term: s.name,
    value: { kind: 'subdivision' as const, name: s.name, country: s.country, subdivision: s.code },
    caseSensitive: true,
  })),
];

/** Free-text place matcher: case-sensitive (capitalised proper nouns only). */
const placeMatcher = new TermMatcher<PlaceValue>(placeEntries);

/** Exact-lookup place matcher (case-insensitive), used for location strings. */
const placeLookup = new TermMatcher<PlaceValue>(placeEntries.map((e) => ({ ...e, caseSensitive: false })));

/**
 * Countries mentioned in free text. Case-insensitive for names/aliases, case-sensitive for short
 * codes (`US`, `UK`, `UAE`) and demonyms. Bare ISO codes are never matched in free text ("IN", "IT",
 * "NO" are ordinary words). Mentions that are part of a region name ("North American",
 * "Latin America") are dropped.
 */
export function findCountries(text: string): CountryMatch[] {
  const regions = regionMatcher.find(text);
  return countryMatcher
    .find(text)
    .filter((m) => !overlapsAny(m.index, m.index + m.matchedText.length, regions))
    .map((m) => ({ code: m.value.code, kind: m.value.kind, matchedText: m.matchedText, index: m.index }));
}

/** Regions mentioned in free text, e.g. "EMEA", "Europe", "LatAm", "the Americas". */
export function findRegions(text: string): RegionMatch[] {
  return regionMatcher.find(text).map((m) => ({ code: m.value, matchedText: m.matchedText, index: m.index }));
}

/** Cities and US-state/Canadian-province names mentioned in free text (capitalised forms only). */
export function findPlaces(text: string): PlaceMatch[] {
  const countries = countryMatcher.find(text);
  return placeMatcher
    .find(text)
    .filter(
      (m) => !overlapsAny(m.index, m.index + m.matchedText.length, countries) || m.value.kind === 'city',
    )
    .map((m) => ({ ...m.value, matchedText: m.matchedText, index: m.index }));
}

/**
 * Normalises a country string ("USA", "U.K.", "Deutschland", "de", "United States of America")
 * to ISO alpha-2, or null when it is not a single recognisable country.
 */
export function normalizeCountry(text: string): string | null {
  const trimmed = text.trim().replace(/^the\s+/i, '');
  if (!trimmed) return null;
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const upper = trimmed.toUpperCase();
    if (upper === 'UK') return 'GB';
    return getCountry(upper) ? upper : null;
  }
  const exact = countryMatcher.lookup(trimmed);
  if (exact) return exact.code;
  const insensitive = COUNTRIES.find((ct) =>
    [...ct.caseSensitiveAliases, ...ct.adjectives].some((a) => normalizeKey(a) === normalizeKey(trimmed)),
  );
  if (insensitive) return insensitive.code;
  const found = findCountries(trimmed);
  const codes = [...new Set(found.map((m) => m.code))];
  return codes.length === 1 ? (codes[0] ?? null) : null;
}

/** Exact, case-insensitive city/subdivision-name lookup ("berlin", "California", "NYC"). */
export function lookupPlace(name: string): Omit<PlaceMatch, 'matchedText' | 'index'> | null {
  return placeLookup.lookup(name) ?? null;
}

/**
 * Resolves a 2-letter postal abbreviation in a location string ("CA", "ON", "NY").
 * Pass `country` to disambiguate (e.g. `CA` is California in the US and the country code of Canada).
 */
export function lookupSubdivisionCode(
  code: string,
  country?: string,
): { country: string; code: string; name: string } | null {
  const upper = code.toUpperCase();
  const hit = SUBDIVISIONS.find((s) => s.code === upper && (!country || s.country === country));
  return hit ? { country: hit.country, code: hit.code, name: hit.name } : null;
}
