import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { JobObservationPayload } from '../contracts/observations';
import {
  cleanString,
  decodeEncodedHtml,
  finalizePayload,
  htmlToText,
  isRecord,
  normalizePeriod,
  toIsoDate,
  type JobPayloadInput,
} from '../connectors/shared';

/** schema.org JobPosting JSON-LD on careers pages → JobObservationPayload (provider `careers_page`). */

type JsonObject = Record<string, unknown>;
type LocationInput = NonNullable<JobPayloadInput['locations']>[number];

function hasType(node: JsonObject, type: string): boolean {
  const raw = node['@type'];
  const types = Array.isArray(raw) ? raw : [raw];
  return types.some(
    (t) => typeof t === 'string' && t.replace(/^(https?:\/\/schema\.org\/|schema:)/, '') === type,
  );
}

/** Every object in a JSON-LD document, descending through arrays, `@graph` and nested values. */
function collectNodes(value: unknown, out: JsonObject[] = [], depth = 0): JsonObject[] {
  if (depth > 8) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, out, depth + 1);
  } else if (isRecord(value)) {
    out.push(value);
    // JobPostings can sit in @graph arrays or nested in ItemLists; never inside another posting.
    if (!hasType(value, 'JobPosting')) {
      for (const child of Object.values(value)) collectNodes(child, out, depth + 1);
    }
  }
  return out;
}

function text(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (isRecord(value)) return cleanString(value.name) ?? cleanString(value['@id']);
  return cleanString(value);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function countryCode(value: string | null): string | null {
  return value && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;
}

function placeLocation(place: unknown): LocationInput | null {
  if (!isRecord(place)) return null;
  const address = isRecord(place.address) ? place.address : null;
  if (!address) {
    const name = text(place.name) ?? text(place.address);
    return name ? { text: name, kind: 'job' } : null;
  }
  const city = cleanString(address.addressLocality);
  const region = cleanString(address.addressRegion);
  const countryText = text(address.addressCountry);
  const parts = [city, region, countryText].filter((p): p is string => !!p);
  if (!parts.length) return null;
  return { text: parts.join(', '), city, region, country: countryCode(countryText), kind: 'job' };
}

function applicantLocation(area: unknown): LocationInput | null {
  const name = text(area);
  if (!name) return null;
  return { text: name, country: countryCode(name), kind: 'job' };
}

function compensation(salary: unknown): JobPayloadInput['compensation'] {
  if (!isRecord(salary)) return null;
  const currency = cleanString(salary.currency)?.toUpperCase() ?? null;
  const value = salary.value;
  const num = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  if (isRecord(value)) {
    const exact = num(value.value);
    return {
      min: num(value.minValue) ?? exact,
      max: num(value.maxValue) ?? exact,
      currency,
      period: normalizePeriod(cleanString(value.unitText)),
    };
  }
  const exact = num(value);
  return exact === null && !currency ? null : { min: exact, max: exact, currency, period: null };
}

function identifier(posting: JsonObject): string | null {
  const id = posting.identifier;
  if (typeof id === 'string' || typeof id === 'number') return cleanString(String(id));
  if (isRecord(id)) return text(id.value);
  return null;
}

function resolveUrl(value: unknown, base: string): string | null {
  const raw = cleanString(value);
  if (!raw) return null;
  try {
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

function mapPosting(posting: JsonObject, pageUrl: string): JobPayloadInput | null {
  const title = cleanString(posting.title) ?? cleanString(posting.name);
  if (!title) return null;
  const postingUrl = resolveUrl(posting.url, pageUrl) ?? pageUrl;
  const externalId =
    identifier(posting) ?? createHash('sha256').update(`${postingUrl}\n${title}`).digest('hex').slice(0, 32);
  const rawDescription = cleanString(posting.description);
  const descriptionHtml = rawDescription ? decodeEncodedHtml(rawDescription) : null;
  const locationTypes = asArray(posting.jobLocationType).map((t) => String(t).toUpperCase());
  const locations = [
    ...asArray(posting.jobLocation).map(placeLocation),
    ...asArray(posting.applicantLocationRequirements).map(applicantLocation),
  ].filter((l): l is LocationInput => l !== null);
  const employment = asArray(posting.employmentType)
    .map((t) => cleanString(t))
    .filter((t): t is string => !!t);
  return {
    externalId,
    title,
    companyName: text(posting.hiringOrganization),
    descriptionHtml,
    descriptionText: descriptionHtml ? htmlToText(descriptionHtml) : null,
    locations,
    // JobPosting only flags telecommuting; absence of the flag does not mean on-site.
    workplaceType: locationTypes.includes('TELECOMMUTE') ? 'remote' : null,
    employmentTypeText: employment.length ? employment.join(', ') : null,
    postingUrl,
    publishedAt: toIsoDate(cleanString(posting.datePosted)),
    compensation: compensation(posting.baseSalary),
    provider: { name: 'careers_page', boardToken: null },
  };
}

/** Extract every schema.org JobPosting from a page's JSON-LD blocks. Invalid blocks are ignored. */
export function extractJsonLdJobPostings(html: string, pageUrl: string): JobObservationPayload[] {
  const $ = load(html);
  const out: JobObservationPayload[] = [];
  $('script').each((_, el) => {
    const type = ($(el).attr('type') ?? '').toLowerCase().trim();
    if (type !== 'application/ld+json') return;
    let doc: unknown;
    try {
      doc = JSON.parse($(el).text());
    } catch {
      return;
    }
    for (const node of collectNodes(doc)) {
      if (!hasType(node, 'JobPosting')) continue;
      const mapped = mapPosting(node, pageUrl);
      const result = mapped ? finalizePayload(mapped) : null;
      if (result?.ok) out.push(result.payload);
    }
  });
  return out;
}
