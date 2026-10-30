import { findRegions, lookupPlace, lookupSubdivisionCode, normalizeCountry } from '@aptamind/taxonomy';
import type { NormalizedLocation } from '../contracts/employment';

/**
 * Listed-location normalisation ("Remote - US", "London, UK", "Hybrid - Berlin", "San Francisco,
 * CA", "Anywhere"). Workplace words are recognised and removed before place resolution; the
 * remaining parts are resolved against the taxonomy (city → subdivision → country). Regions such
 * as "Europe" are not countries and are left to remote-scope interpretation.
 */

const REMOTE_WORDS =
  /\b(?:remote|anywhere|work\s+from\s+home|wfh|distributed|telecommute|home[\s-]based|virtual|worldwide|global)\b/i;
const WORKPLACE_WORDS =
  /\b(?:fully\s+remote|remote(?:\s+first|\s+friendly)?|anywhere|work\s+from\s+home|wfh|distributed|telecommute|home[\s-]based|virtual|worldwide|global(?:ly)?|hybrid|on[\s-]?site|in[\s-]office|office|hq|headquarters|flexible|multiple\s+locations|or\s+remote|only)\b/gi;

export function isRemoteLabel(text: string): boolean {
  return REMOTE_WORDS.test(text);
}

/** Splits a provider location string listing several places ("London; Berlin", "NYC | SF", "London or Remote"). */
export function splitLocationText(text: string): string[] {
  return text
    .split(/\s*;\s*|\s+\|\s+|\s+or\s+|\s*\n\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function normalizeLocation(text: string): NormalizedLocation {
  const remote = isRemoteLabel(text);
  const stripped = text.replace(WORKPLACE_WORDS, ',');
  const parts = stripped
    .split(/[,()[\]/|:;–—]|\s-\s|\s-(?=\S)|(?<=\S)-\s/)
    .map((p) => p.replace(/^[\s.-]+|[\s.-]+$/g, '').trim())
    .filter((p) => p.length > 0);

  let city: string | null = null;
  let cityCountry: string | null = null;
  let citySubdivision: string | null = null;
  let region: string | null = null;
  let country: string | null = null;
  let subdivisionCountry: string | null = null;
  const unresolved: string[] = [];
  const codes: string[] = [];

  for (const part of parts) {
    if (/^[A-Z]{2}$/.test(part)) {
      codes.push(part);
      continue;
    }
    const place = lookupPlace(part);
    if (place?.kind === 'city' && !city) {
      city = place.name;
      cityCountry = place.country;
      citySubdivision = place.subdivision;
      continue;
    }
    if (place?.kind === 'subdivision' && !region) {
      region = place.name;
      subdivisionCountry = place.country;
      continue;
    }
    const iso = normalizeCountry(part);
    if (iso && !country) {
      country = iso;
      continue;
    }
    if (findRegions(part).length) continue;
    unresolved.push(part);
  }

  for (const code of codes) {
    const context = country ?? cityCountry ?? subdivisionCountry;
    const asSubdivision = context ? lookupSubdivisionCode(code, context) : null;
    if (asSubdivision && !region && (!citySubdivision || citySubdivision === code)) {
      region = asSubdivision.name;
      subdivisionCountry = asSubdivision.country;
      continue;
    }
    // Without other context "City, XX" follows the US "City, ST" convention when XX is a state
    // ("Springfield, IL"); otherwise XX is read as an ISO country ("Lyon, FR").
    const usState = !context && !region ? lookupSubdivisionCode(code, 'US') : null;
    if (usState && unresolved.length) {
      region = usState.name;
      subdivisionCountry = 'US';
      continue;
    }
    const iso = code === 'UK' ? 'GB' : normalizeCountry(code);
    if (iso && !country && (!context || context === iso)) {
      country = iso;
      continue;
    }
    if (usState) {
      region = usState.name;
      subdivisionCountry = 'US';
    }
  }

  if (!region && citySubdivision) {
    const sub = lookupSubdivisionCode(citySubdivision, cityCountry ?? undefined);
    region = sub?.name ?? null;
  }
  const resolvedCountry = country ?? cityCountry ?? subdivisionCountry;
  // An unknown leading place before a known subdivision/country is taken as the city ("Springfield, IL").
  const first = unresolved[0];
  if (
    !city &&
    first &&
    resolvedCountry &&
    /^\p{Lu}[\p{L}.' -]{1,40}$/u.test(first) &&
    parts.indexOf(first) === 0
  ) {
    city = first;
  }
  return { text, city, region, country: resolvedCountry, isRemoteLabel: remote };
}

/** Normalises every listed location, splitting multi-location strings. */
export function normalizeLocations(texts: readonly string[]): NormalizedLocation[] {
  const out: NormalizedLocation[] = [];
  for (const text of texts) {
    for (const piece of splitLocationText(text)) out.push(normalizeLocation(piece));
  }
  return out;
}
