/**
 * Timezone vocabulary and constraint parsing for remote-work statements.
 *
 * Offsets are standard-time hours (DST variants such as PDT/CEST have their own entries). Parsing
 * returns an inclusive UTC-offset window the worker must be within, e.g. "within 3 hours of CET"
 * → [-2, +4], "US time zones (PT–ET)" → [-8, -5].
 */

/** Abbreviation → UTC offset (hours). Upper-case only when matched in text. */
export const TIMEZONE_ABBREVIATIONS: Readonly<Record<string, number>> = {
  UTC: 0,
  GMT: 0,
  WET: 0,
  WEST: 1,
  BST: 1,
  CET: 1,
  CEST: 2,
  EET: 2,
  EEST: 3,
  MSK: 3,
  GST: 4, // Gulf Standard Time
  PKT: 5,
  IST: 5.5, // India Standard Time (the dominant meaning in job text)
  ICT: 7,
  WIB: 7,
  SGT: 8,
  HKT: 8,
  AWST: 8,
  JST: 9,
  KST: 9,
  ACST: 9.5,
  AEST: 10,
  AEDT: 11,
  NZST: 12,
  NZDT: 13,
  HST: -10,
  AKST: -9,
  PST: -8,
  PT: -8,
  PDT: -7,
  MST: -7,
  MT: -7,
  MDT: -6,
  CST: -6, // US Central (the dominant meaning in job text)
  CT: -6,
  CDT: -5,
  EST: -5,
  ET: -5,
  EDT: -4,
  AST: -4,
  NST: -3.5,
  BRT: -3,
  ART: -3,
  SAST: 2,
  WAT: 1,
  EAT: 3,
};

/** Spelled-out zone names (case-insensitive). */
export const TIMEZONE_NAMES: Readonly<Record<string, number>> = {
  'pacific time': -8,
  'pacific standard time': -8,
  'mountain time': -7,
  'mountain standard time': -7,
  'central time': -6,
  'central standard time': -6,
  'eastern time': -5,
  'eastern standard time': -5,
  'greenwich mean time': 0,
  'british summer time': 1,
  'central european time': 1,
  'central european summer time': 2,
  'eastern european time': 2,
  'india standard time': 5.5,
  'gulf standard time': 4,
  'singapore time': 8,
  'japan standard time': 9,
  'australian eastern time': 10,
  'australian eastern standard time': 10,
};

/** Named groups of zones commonly used in postings. */
export const TIMEZONE_GROUPS: ReadonlyArray<{ pattern: RegExp; min: number; max: number }> = [
  { pattern: /\b(?:U\.?S\.?|United States|American|North American?)\s+time\s*zones?\b/i, min: -8, max: -5 },
  { pattern: /\b(?:European|EU|Europe)\s+time\s*zones?\b/i, min: 0, max: 2 },
  { pattern: /\b(?:Latin American?|LATAM|South American?)\s+time\s*zones?\b/i, min: -5, max: -3 },
  { pattern: /\b(?:APAC|Asia[- ]Pacific)\s+time\s*zones?\b/i, min: 5.5, max: 10 },
];

export interface TimezoneConstraint {
  minUtcOffset: number;
  maxUtcOffset: number;
  /** The text span the constraint was parsed from. */
  text: string;
  /** Offset of `text` within the parsed input. */
  index: number;
  kind: 'explicit_range' | 'anchor_window' | 'overlap' | 'zone_list' | 'single_zone' | 'named_group';
}

export interface TimezoneMention {
  offset: number;
  matchedText: string;
  index: number;
}

const OFFSET_NUM = '[+\\-−–]\\s?\\d{1,2}(?:[:.]\\d{2})?';
const ABBREV_SOURCE = Object.keys(TIMEZONE_ABBREVIATIONS)
  .filter((k) => k !== 'UTC' && k !== 'GMT')
  .sort((a, b) => b.length - a.length)
  .join('|');
/** Case-insensitive source for a lower-case phrase without relying on regex `i` (tokens must stay case-sensitive). */
function caseInsensitiveSource(phrase: string): string {
  return phrase
    .split(' ')
    .map((word) => [...word].map((ch) => `[${ch}${ch.toUpperCase()}]`).join(''))
    .join('\\s+');
}
const NAME_SOURCE = Object.keys(TIMEZONE_NAMES)
  .sort((a, b) => b.length - a.length)
  .map(caseInsensitiveSource)
  .join('|');

/** One timezone token: `UTC+2`, `GMT`, `CET`, `Pacific Time`. */
const TOKEN_SOURCE = `(?:(?:UTC|GMT)(?:\\s?${OFFSET_NUM})?(?![\\p{L}\\p{N}])|\\b(?:${ABBREV_SOURCE})\\b|\\b(?:${NAME_SOURCE})\\b)`;

function parseOffsetNumber(raw: string): number {
  const cleaned = raw.replace(/\s/g, '').replace(/[−–]/g, '-');
  const m = cleaned.match(/^([+-]?)(\d{1,2})(?:[:.](\d{2}))?$/);
  if (!m) return Number.NaN;
  const hours = Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0);
  return m[1] === '-' ? -hours : hours;
}

/** UTC offset of a single token, or null when unrecognised. */
export function timezoneTokenOffset(token: string): number | null {
  const t = token.trim();
  const utc = t.match(/^(?:UTC|GMT)\s?(.*)$/i);
  if (utc) {
    const rest = utc[1] ?? '';
    if (!rest) return 0;
    const n = parseOffsetNumber(rest);
    return Number.isFinite(n) && Math.abs(n) <= 14 ? n : null;
  }
  const upper = t.toUpperCase();
  if (upper in TIMEZONE_ABBREVIATIONS) return TIMEZONE_ABBREVIATIONS[upper] ?? null;
  const name = t.toLowerCase().replace(/\s+/g, ' ');
  return TIMEZONE_NAMES[name] ?? null;
}

/** All timezone tokens in text with their offsets. */
export function findTimezoneMentions(text: string): TimezoneMention[] {
  const re = new RegExp(TOKEN_SOURCE, 'gu');
  const out: TimezoneMention[] = [];
  for (const m of text.matchAll(re)) {
    const offset = timezoneTokenOffset(m[0]);
    if (offset !== null) out.push({ offset, matchedText: m[0], index: m.index });
  }
  return out;
}

const HOURS = '(\\d{1,2}(?:\\.\\d)?)\\s*(?:\\+\\s*)?(?:hours?|hrs?|h)\\b';
const EXPLICIT_RANGE = new RegExp(
  `(?:UTC|GMT)\\s?([+\\-−–]?\\s?\\d{1,2}(?:[:.]\\d{2})?)\\s*(?:to|until|through|and|[-–—/&])\\s*(?:UTC|GMT)?\\s?([+\\-−–]?\\s?\\d{1,2}(?:[:.]\\d{2})?)(?![\\d])`,
  'u',
);
const ANCHOR_WINDOW = new RegExp(
  `(?:within|±|\\+\\s?\\/\\s?-|\\+-|plus\\s+or\\s+minus|plus\\/minus)\\s*${HOURS}\\s*(?:of|from)?\\s*(?:the\\s+)?(${TOKEN_SOURCE})`,
  'iu',
);
const ANCHOR_WINDOW_AFTER = new RegExp(
  `(${TOKEN_SOURCE})\\s*(?:±|\\+\\s?\\/\\s?-|\\+-)\\s*(?:${HOURS})?`,
  'u',
);
const OVERLAP_HOURS = new RegExp(
  `overlap(?:ping)?\\s+(?:of\\s+)?(?:at\\s+least\\s+|a\\s+minimum\\s+of\\s+)?${HOURS}\\s+(?:with|of|in)\\s+(?:the\\s+)?(${TOKEN_SOURCE})`,
  'iu',
);
const HOURS_OVERLAP = new RegExp(
  `(?:at\\s+least\\s+)?${HOURS}\\s+(?:of\\s+)?(?:daily\\s+)?overlap\\s+(?:with|in)\\s+(?:the\\s+)?(${TOKEN_SOURCE})`,
  'iu',
);
const OVERLAP_PLAIN = new RegExp(`overlap(?:ping)?\\s+(?:with\\s+)?(?:the\\s+)?(${TOKEN_SOURCE})`, 'iu');
const TZ_CONTEXT = /\b(?:time\s*zones?|timezones?|hours|overlap|business\s+day|working\s+day)\b/i;

/** Assumed length of a working day when converting "N hours of overlap" to an offset window. */
export const WORKDAY_HOURS = 8;
/** Overlap assumed when a posting asks for overlap without stating hours. */
export const DEFAULT_OVERLAP_HOURS = 4;

function windowAround(anchor: number, hours: number): [number, number] {
  return [anchor - hours, anchor + hours];
}

/**
 * Parses a timezone constraint from a sentence. Returns null when the text states no constraint.
 * Recognised shapes (in priority order): explicit UTC ranges, "within/± N hours of X",
 * "overlap N hours with X", "overlap with X" (assumes 4h overlap of an 8h day), named groups
 * ("US time zones"), lists/ranges of zones ("EST/PST", "PT–ET"), and a single zone in a timezone context.
 */
export function parseTimezoneConstraint(text: string): TimezoneConstraint | null {
  const build = (
    min: number,
    max: number,
    m: { index: number; 0: string },
    kind: TimezoneConstraint['kind'],
  ) => ({
    minUtcOffset: Math.min(min, max),
    maxUtcOffset: Math.max(min, max),
    text: m[0].trim(),
    index: m.index,
    kind,
  });

  const range = text.match(EXPLICIT_RANGE);
  if (range && range.index !== undefined) {
    const a = parseOffsetNumber(range[1] ?? '');
    const b = parseOffsetNumber(range[2] ?? '');
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 14 && Math.abs(b) <= 14) {
      return build(a, b, { index: range.index, 0: range[0] }, 'explicit_range');
    }
  }

  const anchor = text.match(ANCHOR_WINDOW);
  if (anchor && anchor.index !== undefined) {
    const hours = Number(anchor[1]);
    const base = timezoneTokenOffset(anchor[2] ?? '');
    if (base !== null && Number.isFinite(hours)) {
      const [min, max] = windowAround(base, hours);
      return build(min, max, { index: anchor.index, 0: anchor[0] }, 'anchor_window');
    }
  }
  const anchorAfter = text.match(ANCHOR_WINDOW_AFTER);
  if (anchorAfter && anchorAfter.index !== undefined && anchorAfter[2]) {
    const base = timezoneTokenOffset(anchorAfter[1] ?? '');
    const hours = Number(anchorAfter[2]);
    if (base !== null && Number.isFinite(hours)) {
      const [min, max] = windowAround(base, hours);
      return build(min, max, { index: anchorAfter.index, 0: anchorAfter[0] }, 'anchor_window');
    }
  }

  for (const re of [OVERLAP_HOURS, HOURS_OVERLAP]) {
    const m = text.match(re);
    if (m && m.index !== undefined) {
      const hours = Number(m[1]);
      const base = timezoneTokenOffset(m[2] ?? '');
      if (base !== null && Number.isFinite(hours)) {
        const [min, max] = windowAround(base, Math.max(0, WORKDAY_HOURS - hours));
        return build(min, max, { index: m.index, 0: m[0] }, 'overlap');
      }
    }
  }
  const overlap = text.match(OVERLAP_PLAIN);
  if (overlap && overlap.index !== undefined) {
    const base = timezoneTokenOffset(overlap[1] ?? '');
    if (base !== null) {
      const [min, max] = windowAround(base, WORKDAY_HOURS - DEFAULT_OVERLAP_HOURS);
      return build(min, max, { index: overlap.index, 0: overlap[0] }, 'overlap');
    }
  }

  const mentions = findTimezoneMentions(text);
  if (mentions.length >= 2) {
    const first = mentions[0];
    const last = mentions[mentions.length - 1];
    if (first && last) {
      const offsets = mentions.map((m) => m.offset);
      const span = text.slice(first.index, last.index + last.matchedText.length);
      return build(Math.min(...offsets), Math.max(...offsets), { index: first.index, 0: span }, 'zone_list');
    }
  }

  for (const group of TIMEZONE_GROUPS) {
    const m = text.match(group.pattern);
    if (m && m.index !== undefined)
      return build(group.min, group.max, { index: m.index, 0: m[0] }, 'named_group');
  }

  const single = mentions[0];
  if (single) {
    const explicitOffset = /^(?:UTC|GMT)\s?\S/.test(single.matchedText);
    if (explicitOffset || TZ_CONTEXT.test(text)) {
      return build(
        single.offset,
        single.offset,
        { index: single.index, 0: single.matchedText },
        'single_zone',
      );
    }
  }
  return null;
}
