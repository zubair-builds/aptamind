import { load } from 'cheerio';
import type { z } from 'zod';
import { jobObservationPayloadSchema, type JobObservationPayload } from '../contracts/observations';
import type { AdapterListing, PresenceKeys, SkippedEntry } from './types';

export type CompensationPeriod = 'hour' | 'day' | 'week' | 'month' | 'year';

/** Loose input accepted by {@link finalizePayload}; defaults are applied by the contract schema. */
export type JobPayloadInput = z.input<typeof jobObservationPayloadSchema>;

const ENCODED_TAG = /&lt;\/?[a-z][\s\S]*?&gt;/i;
const LITERAL_TAG = /<\/?[a-z][^>]*>/i;

/**
 * Decode entity-encoded HTML (e.g. Greenhouse `content`: `&lt;p&gt;…`) back to HTML.
 * Strings that already contain literal markup are returned unchanged so real HTML is never stripped.
 */
export function decodeEncodedHtml(input: string): string {
  if (!ENCODED_TAG.test(input) || LITERAL_TAG.test(input)) return input;
  return load(input, null, false).root().text();
}

const BLOCK_SELECTOR =
  'p,div,section,article,header,footer,ul,ol,table,tr,h1,h2,h3,h4,h5,h6,blockquote,pre,dl,dt,dd';

/** Render HTML to readable plain text, preserving paragraph and list-item boundaries. */
export function htmlToText(html: string): string {
  const $ = load(html, null, false);
  $('script,style,noscript,template').remove();
  $('br').replaceWith('\n');
  $('li').each((_, el) => {
    $(el).prepend('- ').append('\n');
  });
  $(BLOCK_SELECTOR).each((_, el) => {
    $(el).prepend('\n').append('\n');
  });
  return $.root()
    .text()
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Trimmed non-empty string, otherwise null. */
export function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** One location entry per distinct location string (case-insensitive), in source order. */
export function locationsFromStrings(
  values: Array<string | null | undefined>,
): Array<{ text: string; kind: 'job' }> {
  const seen = new Set<string>();
  const out: Array<{ text: string; kind: 'job' }> = [];
  for (const value of values) {
    const text = cleanString(value);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push({ text, kind: 'job' });
  }
  return out;
}

/** Map textual pay intervals (`1 YEAR`, `per-hour-wage`, `YEAR`, `annual`…) to a contract period. */
export function normalizePeriod(value: string | null | undefined): CompensationPeriod | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  // Multi-unit intervals such as "2 WEEK" or "6 MONTH" have no contract equivalent.
  const count = /^(\d+)\s/.exec(v);
  if (count && count[1] !== '1') return null;
  if (/hour/.test(v)) return 'hour';
  if (/\bday|daily|per-day/.test(v)) return 'day';
  if (/week/.test(v)) return 'week';
  if (/month/.test(v)) return 'month';
  if (/year|annual|annum/.test(v)) return 'year';
  return null;
}

/** Compact, single-line summary of zod issues for warnings. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * The external id a raw entry would map to (`String(id)`, as every adapter maps it), or null when
 * the entry has no usable id. Used to keep a dropped entry's record "seen".
 */
export function entryExternalId(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const id = raw.id;
  if (typeof id === 'string') return id.trim() ? id : null;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

/** Id-only read of raw listing entries; `isUnlisted` marks entries hidden from the public board. */
export function collectPresence(
  entries: readonly unknown[],
  isUnlisted: (entry: Record<string, unknown>) => boolean = () => false,
): PresenceKeys {
  const keys: PresenceKeys = { listed: [], unlisted: [], anonymous: 0, complete: true };
  for (const entry of entries) {
    const id = entryExternalId(entry);
    if (id === null) keys.anonymous += 1;
    else if (isUnlisted(entry as Record<string, unknown>)) keys.unlisted.push(id);
    else keys.listed.push(id);
  }
  return keys;
}

/** Best-effort id of a raw entry, for warning messages only. */
export function rawId(raw: unknown): string {
  return entryExternalId(raw) ?? 'unknown';
}

/** A malformed entry: recorded as skipped (never absent) and reported as a warning. */
export function skipMalformed(listing: AdapterListing, raw: unknown, locator: string, reason: string): void {
  listing.skipped.push({
    externalId: entryExternalId(raw),
    kind: 'malformed',
    locator,
    reason: reason.slice(0, 300),
  });
  listing.warnings.push(`${locator}: ${reason}`);
}

/** Above this share of malformed entries a listing is not a reliable complete snapshot. */
export const MAX_MALFORMED_RATIO = 0.1;

/**
 * Final completeness rule shared by every adapter (M6.1). Dropped entries never become absences
 * (their ids count as seen), but a listing only proves absence when the adapter could read it:
 * it is incomplete when a malformed entry has no usable id (it could be any job) or when more
 * than {@link MAX_MALFORMED_RATIO} of its listed + malformed entries are malformed (provider
 * shape drift; unlisted entries are not counted).
 */
export function finishListing(listing: AdapterListing): AdapterListing {
  const malformed = listing.skipped.filter((s: SkippedEntry) => s.kind === 'malformed');
  // The share is of the entries the adapter tried to map: listed + malformed. Unlisted entries
  // are a provider state, not parse attempts, so they do not dilute the ratio (A-L4).
  const entries = listing.jobs.length + malformed.length;
  if (!listing.complete || !malformed.length) return listing;
  const anonymous = malformed.filter((s) => s.externalId === null).length;
  if (anonymous) {
    listing.complete = false;
    listing.warnings.push(
      `${anonymous} malformed entr${anonymous === 1 ? 'y has' : 'ies have'} no usable id; listing treated as incomplete`,
    );
  } else if (malformed.length / entries > MAX_MALFORMED_RATIO) {
    listing.complete = false;
    listing.warnings.push(
      `${malformed.length}/${entries} entries malformed (> ${MAX_MALFORMED_RATIO * 100} %); listing treated as incomplete`,
    );
  }
  return listing;
}

/**
 * Validate a mapped payload against the contract. Returns the parsed payload (defaults applied)
 * or a warning string; adapters never emit payloads that violate the contract.
 */
export function finalizePayload(
  input: JobPayloadInput,
): { ok: true; payload: JobObservationPayload } | { ok: false; warning: string } {
  const parsed = jobObservationPayloadSchema.safeParse(input);
  if (parsed.success) return { ok: true, payload: parsed.data };
  return { ok: false, warning: describeIssues(parsed.error) };
}

/** ISO-8601 string for a date-like value, or null when unparseable. */
export function toIsoDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Escape text for safe interpolation into HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
