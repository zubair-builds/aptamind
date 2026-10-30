import { z } from 'zod';
import type { JobObservationPayload } from '../contracts/observations';
import {
  cleanString,
  describeIssues,
  escapeHtml,
  finalizePayload,
  collectPresence,
  finishListing,
  htmlToText,
  locationsFromStrings,
  normalizePeriod,
  rawId,
  skipMalformed,
  toIsoDate,
  type JobPayloadInput,
} from './shared';
import { onBase } from './regions';
import type { AdapterListing, JobBoardAdapter, JobCheckResult, PresenceKeys } from './types';

/** Lever Postings API (`api.lever.co/v0/postings`; EU-hosted accounts: `api.eu.lever.co`). */

const API_BASES = {
  default: 'https://api.lever.co/v0/postings',
  eu: 'https://api.eu.lever.co/v0/postings',
} as const;

const postingSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1),
  categories: z
    .object({
      location: z.string().nullish(),
      commitment: z.string().nullish(),
      team: z.string().nullish(),
      department: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
    })
    .nullish(),
  country: z.string().nullish(),
  workplaceType: z.string().nullish(),
  description: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  lists: z.array(z.object({ text: z.string().nullish(), content: z.string().nullish() })).nullish(),
  additional: z.string().nullish(),
  additionalPlain: z.string().nullish(),
  hostedUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  createdAt: z.number().nullish(),
  salaryRange: z
    .object({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: z.string().nullish(),
      interval: z.string().nullish(),
    })
    .nullish(),
  salaryDescription: z.string().nullish(),
  salaryDescriptionPlain: z.string().nullish(),
});
type LeverPosting = z.infer<typeof postingSchema>;

const WORKPLACE: Record<string, JobObservationPayload['workplaceType']> = {
  remote: 'remote',
  hybrid: 'hybrid',
  'on-site': 'onsite',
  onsite: 'onsite',
};

/** Lever splits the body into description, titled lists and closing text; recombine them in page order. */
function combinedDescription(p: LeverPosting): string | null {
  const parts: string[] = [];
  if (cleanString(p.description)) parts.push(p.description as string);
  for (const list of p.lists ?? []) {
    const heading = cleanString(list.text);
    const content = cleanString(list.content);
    if (!heading && !content) continue;
    parts.push(`${heading ? `<h3>${escapeHtml(heading)}</h3>` : ''}${content ? `<ul>${content}</ul>` : ''}`);
  }
  if (cleanString(p.additional)) parts.push(p.additional as string);
  return parts.length ? parts.join('\n') : null;
}

function compensation(p: LeverPosting): JobPayloadInput['compensation'] {
  const range = p.salaryRange;
  const text =
    cleanString(p.salaryDescriptionPlain) ??
    (cleanString(p.salaryDescription) ? htmlToText(p.salaryDescription as string) : null);
  if (!range && !text) return null;
  return {
    text,
    min: range?.min ?? null,
    max: range?.max ?? null,
    currency: cleanString(range?.currency)?.toUpperCase() ?? null,
    period: normalizePeriod(range?.interval),
  };
}

function mapPosting(p: LeverPosting, boardToken: string): JobPayloadInput {
  const descriptionHtml = combinedDescription(p);
  const allLocations = p.categories?.allLocations?.length
    ? p.categories.allLocations
    : [p.categories?.location];
  const locations = locationsFromStrings(allLocations);
  // Lever's `country` is posting-level; attribute it only when there is a single location to attach it to.
  const country = cleanString(p.country)?.toUpperCase();
  const first = locations[0];
  const located =
    locations.length === 1 && first && country && /^[A-Z]{2}$/.test(country)
      ? [{ ...first, country }]
      : locations;
  return {
    externalId: p.id,
    requisitionId: null,
    title: p.text,
    descriptionHtml,
    descriptionText: descriptionHtml ? htmlToText(descriptionHtml) : null,
    locations: located,
    workplaceType: WORKPLACE[(p.workplaceType ?? '').toLowerCase()] ?? null,
    employmentTypeText: cleanString(p.categories?.commitment),
    department: cleanString(p.categories?.department),
    team: cleanString(p.categories?.team),
    postingUrl: cleanString(p.hostedUrl),
    applyUrl: cleanString(p.applyUrl),
    publishedAt: toIsoDate(p.createdAt),
    compensation: compensation(p),
    provider: { name: 'lever', boardToken },
  };
}

function parseOne(
  raw: unknown,
  boardToken: string,
): { payload: JobObservationPayload } | { warning: string } {
  const parsed = postingSchema.safeParse(raw);
  if (!parsed.success) {
    return { warning: `skipped malformed posting (id ${rawId(raw)}): ${describeIssues(parsed.error)}` };
  }
  const result = finalizePayload(mapPosting(parsed.data, boardToken));
  if (!result.ok) return { warning: `skipped posting ${parsed.data.id}: ${result.warning}` };
  return { payload: result.payload };
}

export const leverAdapter: JobBoardAdapter = {
  provider: 'lever',
  adapterVersion: 'lever@1',

  apiBases: API_BASES,

  listingUrl(boardToken, apiBase = API_BASES.default) {
    return onBase(apiBase, `${encodeURIComponent(boardToken)}?mode=json`);
  },

  jobUrl(boardToken, externalId, apiBase = API_BASES.default) {
    return onBase(apiBase, `${encodeURIComponent(boardToken)}/${encodeURIComponent(externalId)}`);
  },

  parseListing(raw, { boardToken }): AdapterListing {
    if (!Array.isArray(raw)) {
      throw new Error(`Lever listing for company "${boardToken}" is not a JSON array of postings`);
    }
    // Without skip/limit the endpoint returns every published posting.
    const listing: AdapterListing = { jobs: [], skipped: [], complete: true, warnings: [] };
    raw.forEach((entry: unknown, index) => {
      const locator = `/${index}`;
      const result = parseOne(entry, boardToken);
      if ('warning' in result) skipMalformed(listing, entry, locator, result.warning);
      else listing.jobs.push({ payload: result.payload, locator });
    });
    return finishListing(listing);
  },

  presenceKeys(raw, { boardToken }): PresenceKeys {
    if (!Array.isArray(raw)) {
      throw new Error(`Lever listing for company "${boardToken}" is not a JSON array of postings`);
    }
    return collectPresence(raw);
  },

  parseJobCheck(status, raw, { boardToken, externalId }): JobCheckResult {
    if (status === 404 || status === 410) return { outcome: 'not_found' };
    if (status < 200 || status >= 300) return { outcome: 'unknown' };
    const result = parseOne(raw, boardToken);
    if ('warning' in result || result.payload.externalId !== externalId) return { outcome: 'unknown' };
    return { outcome: 'live', payload: result.payload };
  },
};
