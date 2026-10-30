import {
  countriesOfRegion,
  findCountries,
  findPlaces,
  findRegions,
  findTimezoneMentions,
  parseTimezoneConstraint,
} from '@aptamind/taxonomy';
import type { EvidenceSpan, NormalizedLocation, RemoteScope } from '../contracts/employment';
import { locationFieldText, sentences, spanOf, unique } from './text';
import type { Confidence, Interpreted, InterpretationFlag, Segment } from './text';
import type { WorkModel } from './work-model';

/**
 * Remote scope: where a remote role may actually be performed.
 *
 * Explicit description restrictions ("must be based in the US", "EMEA only", "within UTC-3 to
 * UTC+3") win over location labels ("Remote - US") which win over nothing. A plain "Remote" with
 * no scope statement is `unclear` — worldwide is only asserted when the posting says so.
 * Hybrid/onsite roles get `not_applicable`.
 */

export interface RestrictionStatement {
  kind: 'location' | 'authorization' | 'worldwide' | 'timezone';
  countries: string[];
  regions: string[];
  excludedCountries: string[];
  excludedRegions: string[];
  timezone: RemoteScope['timezone'];
  /** Strong wording ("must", "only") → high confidence. */
  strong: boolean;
  /** Offsets of the restriction fragment within the description. */
  start: number;
  end: number;
  sentence: Segment;
}

/** Triggers that introduce where the worker must be. The fragment from the trigger to the sentence end is scanned. */
const LOCATION_TRIGGERS: ReadonlyArray<{ pattern: RegExp; strong: boolean }> = [
  {
    pattern:
      /\b(?:must|should|need\s+to|needs\s+to|required\s+to|have\s+to|will\s+need\s+to|are\s+required\s+to)\s+(?:be\s+)?(?:currently\s+|permanently\s+|physically\s+|legally\s+)?(?:based|located|living|residing|reside|live|resident)\s+(?:in|within|inside)\b/i,
    strong: true,
  },
  {
    pattern:
      /\b(?:candidates?|applicants?|you|employees|team\s+members)\s+(?:must\s+|should\s+|need\s+to\s+)?(?:be\s+)?(?:currently\s+)?(?:based|located|living|residing|reside|live)\s+(?:in|within)\b/i,
    strong: true,
  },
  {
    pattern:
      /\b(?:only\s+)?(?:open|available)\s+(?:only\s+)?to\s+(?:candidates|applicants|people|those|residents|individuals|anyone|talent|engineers)?\s*(?:who\s+(?:are|live)\s+)?(?:currently\s+)?(?:based|located|living|residing)?\s*(?:in|from|within)\b/i,
    strong: true,
  },
  {
    pattern:
      /\b(?:we\s+)?(?:can|are\s+able\s+to|currently|only)?\s*(?:only\s+)?(?:hire|employ|recruit|consider\s+candidates)\s+(?:people\s+|candidates\s+|employees\s+|talent\s+)?(?:who\s+(?:live|are\s+based)\s+)?(?:in|from|based\s+in)\b/i,
    strong: true,
  },
  { pattern: /\bonly\s+(?:in|within|from)\b/i, strong: true },
  { pattern: /\b[Rr]emote\s*(?:\(|-|–|,|:)?\s*(?:within|in|from|across|throughout)\b/, strong: true },
  {
    pattern:
      /\b(?:work|working)\s+(?:fully\s+)?remotely\s+(?:from\s+)?(?:anywhere\s+)?(?:in|within|across|from)\b/i,
    strong: true,
  },
  { pattern: /\banywhere\s+(?:in|within|across|throughout)\b/i, strong: true },
];

/** "US-only", "EMEA only", "UK only". */
const ONLY_SUFFIX = /\b((?:U\.S\.|U\.K\.|[A-Z][\w.&]*(?:\s+[A-Z][\w.&]*)?))[\s-]+only\b/g;
/** "US-based candidates", "EU-based applicants". */
const BASED_CANDIDATES =
  /\b((?:U\.S\.|[A-Z][\w.&]*))-based\s+(?:candidates|applicants|talent|engineers|developers|designers|individuals|people|team\s+members|employees|hires|role|position|remote\s+role)\b/g;
const AUTHORIZATION_TRIGGER =
  /\b(?:eligible|authori[sz]ed|legally\s+(?:able|allowed|entitled)|right)\s+to\s+work\s+(?:in|from|within)\b/i;
const EXCLUSION =
  /\b(?:except(?:\s+for)?|excluding|with\s+the\s+exception\s+of|other\s+than|not\s+including|apart\s+from)\b/i;
const EXCLUSION_STATEMENT =
  /\b(?:(?:cannot|can't|can\s+not|are\s+unable\s+to|unable\s+to|do\s+not|don't|not\s+able\s+to)\s+(?:currently\s+)?(?:hire|employ|consider\s+candidates|accept\s+applications)\s+(?:in|from)|not\s+(?:open|available)\s+(?:to\s+candidates\s+)?(?:in|from))\b/i;
/** Clause boundaries after which a new subject starts ("…in the UK, and our HQ is in Berlin"). */
const CLAUSE_BREAK =
  /[,;]\s+(?:and|but|while|as|where|whereas|we|our|with\s+(?:our|an?)\s)|\s+(?:but|while|whereas|because|as\s+we|and\s+(?:our|we))\b/i;
const WORLDWIDE =
  /\b(?:anywhere\s+in\s+the\s+world|(?:work|working|live|located)\s+(?:from\s+)?anywhere(?!\s+(?:in|within|across|throughout)\b)|from\s+anywhere(?!\s+(?:in|within|across|throughout)\b)|worldwide|world-wide|globally\s+remote|global(?:ly)?\s+distributed\s+and\s+remote|location[\s-]independent|any\s+(?:country|location)|all\s+(?:countries|locations)|no\s+location\s+restrictions?|regardless\s+of\s+(?:your\s+)?location|remote\s*[-(,]?\s*(?:global|worldwide))\b/i;
const TZ_HINT =
  /\b(?:time\s*zones?|timezones?|UTC|GMT|overlap|business\s+hours|working\s+hours|core\s+hours|[A-Z]{2,4}\s+hours)\b/;

interface GeoSet {
  countries: string[];
  regions: string[];
}

/** Countries/regions named in a fragment (cities and states resolve to their country). */
export function geoOf(fragment: string): GeoSet {
  const regions = findRegions(fragment).map((r) => r.code);
  const countries = [
    ...findCountries(fragment).map((c) => ({ code: c.code, index: c.index })),
    ...findPlaces(fragment).map((p) => ({ code: p.country, index: p.index })),
  ]
    .sort((a, b) => a.index - b.index)
    .map((c) => c.code);
  return { countries: unique(countries), regions: unique(regions) };
}

function splitExclusion(fragment: string): { included: string; excluded: string } {
  const m = fragment.match(EXCLUSION);
  if (!m || m.index === undefined) return { included: fragment, excluded: '' };
  return { included: fragment.slice(0, m.index), excluded: fragment.slice(m.index + m[0].length) };
}

export function cutAtClause(fragment: string): string {
  const m = fragment.slice(1).match(CLAUSE_BREAK);
  return m && m.index !== undefined ? fragment.slice(0, m.index + 1) : fragment;
}

function statementFrom(
  kind: RestrictionStatement['kind'],
  sentence: Segment,
  relStart: number,
  relEnd: number,
  strong: boolean,
): RestrictionStatement | null {
  const fragment = sentence.text.slice(relStart, relEnd);
  const { included, excluded } = splitExclusion(fragment);
  const inc = geoOf(included);
  const exc = geoOf(excluded);
  if (!inc.countries.length && !inc.regions.length && !exc.countries.length && !exc.regions.length)
    return null;
  return {
    kind,
    countries: inc.countries,
    regions: inc.regions,
    excludedCountries: exc.countries,
    excludedRegions: exc.regions,
    timezone: null,
    strong,
    start: sentence.start + relStart,
    end: sentence.start + relEnd,
    sentence,
  };
}

/** All remote-scope restriction statements in a description. */
export function findRemoteRestrictions(description: string): RestrictionStatement[] {
  const out: RestrictionStatement[] = [];
  for (const sentence of sentences(description)) {
    const text = sentence.text;
    let matched = false;
    const excl = text.match(EXCLUSION_STATEMENT);
    const inExclusion = (index: number) =>
      !!excl && excl.index !== undefined && index >= excl.index && index < excl.index + excl[0].length;
    for (const trigger of LOCATION_TRIGGERS) {
      const m = text.match(trigger.pattern);
      if (!m || m.index === undefined || inExclusion(m.index)) continue;
      const rest = cutAtClause(text.slice(m.index));
      const st = statementFrom('location', sentence, m.index, m.index + rest.length, trigger.strong);
      if (st) {
        out.push(st);
        matched = true;
        break;
      }
    }
    if (!matched) {
      for (const re of [ONLY_SUFFIX, BASED_CANDIDATES]) {
        for (const m of text.matchAll(re)) {
          const st = statementFrom('location', sentence, m.index, m.index + m[0].length, true);
          if (st) {
            out.push(st);
            matched = true;
          }
        }
        if (matched) break;
      }
    }
    if (excl && excl.index !== undefined) {
      const rest = cutAtClause(text.slice(excl.index + excl[0].length));
      const geo = geoOf(rest);
      if (geo.countries.length || geo.regions.length) {
        out.push({
          kind: 'location',
          countries: [],
          regions: [],
          excludedCountries: geo.countries,
          excludedRegions: geo.regions,
          timezone: null,
          strong: true,
          start: sentence.start + excl.index,
          end: sentence.start + excl.index + excl[0].length + rest.length,
          sentence,
        });
      }
    }
    if (!matched) {
      const auth = text.match(AUTHORIZATION_TRIGGER);
      if (auth && auth.index !== undefined) {
        const rest = cutAtClause(text.slice(auth.index));
        const st = statementFrom('authorization', sentence, auth.index, auth.index + rest.length, false);
        if (st && st.countries.length) out.push(st);
      }
    }
    if (TZ_HINT.test(text) || findTimezoneMentions(text).length) {
      const tz = parseTimezoneConstraint(text);
      if (tz) {
        out.push({
          kind: 'timezone',
          countries: [],
          regions: [],
          excludedCountries: [],
          excludedRegions: [],
          timezone: { minUtcOffset: tz.minUtcOffset, maxUtcOffset: tz.maxUtcOffset, text: tz.text },
          strong: tz.kind !== 'overlap' || /\d/.test(tz.text),
          start: sentence.start + tz.index,
          end: sentence.start + tz.index + tz.text.length,
          sentence,
        });
      }
    }
    const ww = text.match(WORLDWIDE);
    if (ww && ww.index !== undefined) {
      out.push({
        kind: 'worldwide',
        countries: [],
        regions: [],
        excludedCountries: [],
        excludedRegions: [],
        timezone: null,
        strong: true,
        start: sentence.start + ww.index,
        end: sentence.start + ww.index + ww[0].length,
        sentence,
      });
    }
  }
  return out;
}

export interface RemoteScopeInput {
  workModel: WorkModel;
  /** Work-model confidence/evidence, reused for `not_applicable` scopes. */
  workModelConfidence: Confidence;
  workModelEvidence: EvidenceSpan[];
  title: string;
  description: string;
  locationTexts: readonly string[];
  locations: readonly NormalizedLocation[];
}

export interface RemoteScopeResult {
  remoteScope: Interpreted<RemoteScope>;
  restrictions: RestrictionStatement[];
  flags: InterpretationFlag[];
}

const EMPTY_SCOPE = (type: RemoteScope['type']): RemoteScope => ({
  type,
  countries: [],
  regions: [],
  excludedCountries: [],
  excludedRegions: [],
  timezone: null,
});

function scopeType(
  countries: string[],
  regions: string[],
): { type: RemoteScope['type']; countries: string[] } {
  if (!regions.length) return { type: countries.length > 1 ? 'selected_countries' : 'country', countries };
  if (!countries.length) return { type: 'region', countries: [] };
  const covered = countries.every((c) => regions.some((r) => countriesOfRegion(r).includes(c)));
  return covered ? { type: 'region', countries: [] } : { type: 'selected_countries', countries };
}

export function interpretRemoteScope(input: RemoteScopeInput): RemoteScopeResult {
  const { workModel, description, title, locationTexts } = input;
  const flags: InterpretationFlag[] = [];
  const restrictions = workModel === 'remote' ? findRemoteRestrictions(description) : [];

  if (workModel === 'hybrid' || workModel === 'onsite') {
    return {
      remoteScope: {
        value: EMPTY_SCOPE('not_applicable'),
        confidence: input.workModelConfidence,
        evidence: input.workModelEvidence,
        basis: 'derived.workModel',
      },
      restrictions,
      flags,
    };
  }
  if (workModel === 'unclear') {
    return {
      remoteScope: { value: EMPTY_SCOPE('unclear'), confidence: 'unknown', evidence: [], basis: 'none' },
      restrictions,
      flags,
    };
  }

  const descCountries: string[] = [];
  const descRegions: string[] = [];
  const excludedCountries: string[] = [];
  const excludedRegions: string[] = [];
  const evidence: EvidenceSpan[] = [];
  let strong = false;
  let authOnly = true;
  for (const r of restrictions) {
    if (r.kind !== 'location' && r.kind !== 'authorization') continue;
    descCountries.push(...r.countries);
    descRegions.push(...r.regions);
    excludedCountries.push(...r.excludedCountries);
    excludedRegions.push(...r.excludedRegions);
    if (r.countries.length || r.regions.length || r.excludedCountries.length || r.excludedRegions.length) {
      evidence.push(spanOf('description', description, r.sentence.start, r.sentence.end));
      strong ||= r.strong;
      if (r.kind === 'location') authOnly = false;
    }
  }
  const tz = restrictions.find((r) => r.kind === 'timezone');
  const worldwide = restrictions.find((r) => r.kind === 'worldwide');

  // Location/title labels.
  const locText = locationFieldText(locationTexts);
  const labelCountries: string[] = [];
  const labelRegions: string[] = [];
  const labelEvidence: EvidenceSpan[] = [];
  let labelWorldwide: EvidenceSpan | null = null;
  let plainRemoteLabel = false;
  let offset = 0;
  for (const text of input.locationTexts) {
    const locs = input.locations.filter((l) => l.text === text || text.includes(l.text));
    const remoteLabel = /\b(?:remote|anywhere|work\s+from\s+home|wfh|distributed|worldwide|global)\b/i.test(
      text,
    );
    if (remoteLabel) {
      const regions = findRegions(text).map((r) => r.code);
      const countries = unique(locs.map((l) => l.country).filter((c): c is string => !!c));
      const span = spanOf('location', locText, offset, offset + text.length);
      if (/\b(?:anywhere|worldwide|global)\b/i.test(text) && !regions.length && !countries.length)
        labelWorldwide = span;
      else if (!regions.length && !countries.length) plainRemoteLabel = true;
      else {
        labelCountries.push(...countries);
        labelRegions.push(...regions);
        labelEvidence.push(span);
      }
    }
    offset += text.length + 1;
  }
  if (/\bremote\b/i.test(title)) {
    const inTitle = geoOf(title.replace(/^[^(|–—-]*/, ''));
    if (inTitle.countries.length || inTitle.regions.length) {
      labelCountries.push(...inTitle.countries);
      labelRegions.push(...inTitle.regions);
      labelEvidence.push(spanOf('title', title, 0, title.length));
    } else {
      plainRemoteLabel = true;
    }
  }

  const tzValue = tz?.timezone ?? null;
  const withTz = (scope: RemoteScope): RemoteScope => ({ ...scope, timezone: tzValue });
  const exclusions = {
    excludedCountries: unique(excludedCountries),
    excludedRegions: unique(excludedRegions),
  };

  const hasDesc = descCountries.length || descRegions.length;
  if (hasDesc) {
    const { type, countries } = scopeType(unique(descCountries), unique(descRegions));
    const labelGeo = [...labelCountries, ...labelRegions].sort().join(',');
    const descGeo = [...countries, ...unique(descRegions)].sort().join(',');
    if (plainRemoteLabel || labelWorldwide || (labelGeo && labelGeo !== descGeo)) {
      flags.push({
        code: 'remote_label_restricted',
        message: `Listed as remote${labelGeo ? ` (${labelGeo})` : ''} but the description restricts where the work can be done (${descGeo}).`,
        severity: 'warning',
      });
    }
    if (tz) evidence.push(spanOf('description', description, tz.sentence.start, tz.sentence.end));
    const confidence: Confidence = authOnly ? 'medium' : strong ? 'high' : 'medium';
    return {
      remoteScope: {
        value: withTz({ ...EMPTY_SCOPE(type), countries, regions: unique(descRegions), ...exclusions }),
        confidence,
        evidence: dedupeEvidence(evidence),
        basis: authOnly ? 'description.authorization' : 'description.explicit',
      },
      restrictions,
      flags,
    };
  }

  if (labelCountries.length || labelRegions.length) {
    const { type, countries } = scopeType(unique(labelCountries), unique(labelRegions));
    if (tz) labelEvidence.push(spanOf('description', description, tz.sentence.start, tz.sentence.end));
    return {
      remoteScope: {
        value: withTz({ ...EMPTY_SCOPE(type), countries, regions: unique(labelRegions), ...exclusions }),
        confidence: 'medium',
        evidence: dedupeEvidence(labelEvidence),
        basis: 'location.label',
      },
      restrictions,
      flags,
    };
  }

  if (tz && tzValue) {
    if (plainRemoteLabel || labelWorldwide) {
      flags.push({
        code: 'remote_label_restricted',
        message: `Listed as remote but the description restricts time zones (${tzValue.text}).`,
        severity: 'info',
      });
    }
    return {
      remoteScope: {
        value: { ...EMPTY_SCOPE('timezone'), timezone: tzValue, ...exclusions },
        confidence: tz.strong ? 'high' : 'medium',
        evidence: [spanOf('description', description, tz.sentence.start, tz.sentence.end)],
        basis: 'description.timezone',
      },
      restrictions,
      flags,
    };
  }

  if (worldwide || labelWorldwide) {
    const ev = worldwide
      ? [spanOf('description', description, worldwide.sentence.start, worldwide.sentence.end)]
      : [];
    if (labelWorldwide) ev.push(labelWorldwide);
    return {
      remoteScope: {
        value: { ...EMPTY_SCOPE('worldwide'), ...exclusions },
        confidence: worldwide ? 'high' : 'medium',
        evidence: ev,
        basis: worldwide ? 'description.explicit' : 'location.label',
      },
      restrictions,
      flags,
    };
  }

  if (exclusions.excludedCountries.length || exclusions.excludedRegions.length) {
    return {
      remoteScope: {
        value: { ...EMPTY_SCOPE('unclear'), ...exclusions },
        confidence: 'low',
        evidence: dedupeEvidence(evidence),
        basis: 'description.exclusions',
      },
      restrictions,
      flags,
    };
  }

  return {
    remoteScope: { value: EMPTY_SCOPE('unclear'), confidence: 'unknown', evidence: [], basis: 'none' },
    restrictions,
    flags,
  };
}

function dedupeEvidence(spans: EvidenceSpan[]): EvidenceSpan[] {
  const seen = new Set<string>();
  return spans.filter((s) => {
    const key = `${s.field}:${s.start}:${s.end}:${s.quote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
