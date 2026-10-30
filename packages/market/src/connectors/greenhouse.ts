import { z } from 'zod';
import type { JobObservationPayload } from '../contracts/observations';
import {
  cleanString,
  decodeEncodedHtml,
  describeIssues,
  finalizePayload,
  collectPresence,
  finishListing,
  htmlToText,
  isRecord,
  locationsFromStrings,
  normalizePeriod,
  rawId,
  skipMalformed,
  toIsoDate,
  type JobPayloadInput,
} from './shared';
import { onBase } from './regions';
import type { AdapterListing, JobBoardAdapter, JobCheckResult, PresenceKeys } from './types';

/** Greenhouse Job Board API (`boards-api.greenhouse.io/v1`; EU-hosted boards: `boards-api.eu.greenhouse.io`). */

const API_BASES = {
  default: 'https://boards-api.greenhouse.io/v1/boards',
  eu: 'https://boards-api.eu.greenhouse.io/v1/boards',
} as const;

const payRangeSchema = z.object({
  min_cents: z.number().nullish(),
  max_cents: z.number().nullish(),
  currency_type: z.string().nullish(),
  title: z.string().nullish(),
  blurb: z.string().nullish(),
});

const metadataSchema = z.object({
  name: z.string(),
  value: z.unknown(),
  value_type: z.string().nullish(),
});

const jobSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  internal_job_id: z.number().nullish(),
  title: z.string().trim().min(1),
  updated_at: z.string().nullish(),
  first_published: z.string().nullish(),
  requisition_id: z.string().nullish(),
  company_name: z.string().nullish(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  absolute_url: z.string().nullish(),
  content: z.string().nullish(),
  departments: z.array(z.object({ name: z.string() })).nullish(),
  offices: z.array(z.object({ name: z.string(), location: z.string().nullish() })).nullish(),
  metadata: z.array(metadataSchema).nullish(),
  pay_input_ranges: z.array(payRangeSchema).nullish(),
});
type GreenhouseJob = z.infer<typeof jobSchema>;

function metadataValue(job: GreenhouseJob, pattern: RegExp): string | null {
  const entry = job.metadata?.find((m) => pattern.test(m.name));
  if (!entry) return null;
  if (Array.isArray(entry.value)) {
    const values = entry.value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    return values.length ? values.join(', ') : null;
  }
  return cleanString(entry.value);
}

/** Greenhouse has no structured workplace flag; boards commonly expose one as a custom metadata field. */
function workplaceFromMetadata(job: GreenhouseJob): JobObservationPayload['workplaceType'] {
  const value = metadataValue(job, /workplace|location type|remote status|work model/i)?.toLowerCase();
  if (!value) return null;
  if (/hybrid/.test(value)) return 'hybrid';
  if (/remote/.test(value)) return 'remote';
  if (/on[- ]?site|in[- ]?office|office/.test(value)) return 'onsite';
  return null;
}

function formatMoney(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function compensation(job: GreenhouseJob): JobPayloadInput['compensation'] {
  const ranges = job.pay_input_ranges ?? [];
  const first = ranges[0];
  if (!first) return null;
  const min = typeof first.min_cents === 'number' ? first.min_cents / 100 : null;
  const max = typeof first.max_cents === 'number' ? first.max_cents / 100 : null;
  const currency = cleanString(first.currency_type)?.toUpperCase() ?? null;
  const text = ranges
    .map((r) => {
      const lo = typeof r.min_cents === 'number' ? formatMoney(r.min_cents / 100) : '?';
      const hi = typeof r.max_cents === 'number' ? formatMoney(r.max_cents / 100) : '?';
      const label = cleanString(r.title);
      return `${label ? `${label}: ` : ''}${lo} - ${hi} ${r.currency_type ?? ''}`.trim();
    })
    .join('; ');
  // Pay ranges carry no interval; infer it only from the range's own wording.
  const period = normalizePeriod(`${first.title ?? ''} ${first.blurb ?? ''}`);
  return { text, min, max, currency, period };
}

function mapJob(job: GreenhouseJob, boardToken: string): JobPayloadInput {
  const descriptionHtml = job.content ? decodeEncodedHtml(job.content) : null;
  return {
    externalId: String(job.id),
    requisitionId: cleanString(job.requisition_id),
    title: job.title,
    companyName: cleanString(job.company_name),
    descriptionHtml,
    descriptionText: descriptionHtml ? htmlToText(descriptionHtml) : null,
    locations: locationsFromStrings([job.location?.name]),
    workplaceType: workplaceFromMetadata(job),
    employmentTypeText: metadataValue(job, /employment type|job type|commitment/i),
    department: cleanString(job.departments?.[0]?.name),
    team: null,
    postingUrl: cleanString(job.absolute_url),
    // Greenhouse hosts the application form on the posting page itself.
    applyUrl: cleanString(job.absolute_url),
    publishedAt: toIsoDate(job.first_published),
    sourceUpdatedAt: toIsoDate(job.updated_at),
    compensation: compensation(job),
    provider: { name: 'greenhouse', boardToken },
  };
}

function parseOne(
  raw: unknown,
  boardToken: string,
): { payload: JobObservationPayload } | { warning: string } {
  const parsed = jobSchema.safeParse(raw);
  if (!parsed.success)
    return { warning: `skipped malformed job (id ${rawId(raw)}): ${describeIssues(parsed.error)}` };
  const result = finalizePayload(mapJob(parsed.data, boardToken));
  if (!result.ok) return { warning: `skipped job ${String(parsed.data.id)}: ${result.warning}` };
  return { payload: result.payload };
}

export const greenhouseAdapter: JobBoardAdapter = {
  provider: 'greenhouse',
  adapterVersion: 'greenhouse@1',

  apiBases: API_BASES,

  listingUrl(boardToken, apiBase = API_BASES.default) {
    return onBase(apiBase, `${encodeURIComponent(boardToken)}/jobs?content=true`);
  },

  jobUrl(boardToken, externalId, apiBase = API_BASES.default) {
    return onBase(
      apiBase,
      `${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(externalId)}?pay_transparency=true`,
    );
  },

  parseListing(raw, { boardToken }): AdapterListing {
    if (!isRecord(raw) || !Array.isArray(raw.jobs)) {
      throw new Error(`Greenhouse listing for board "${boardToken}" is not a { jobs: [...] } object`);
    }
    const listing: AdapterListing = { jobs: [], skipped: [], complete: true, warnings: [] };
    raw.jobs.forEach((entry: unknown, index) => {
      const locator = `/jobs/${index}`;
      const result = parseOne(entry, boardToken);
      if ('warning' in result) skipMalformed(listing, entry, locator, result.warning);
      else listing.jobs.push({ payload: result.payload, locator });
    });
    // The list endpoint is unpaginated; a total that disagrees with the array means a truncated response.
    const total = isRecord(raw.meta) ? raw.meta.total : undefined;
    if (typeof total === 'number' && total !== raw.jobs.length) {
      listing.complete = false;
      listing.warnings.push(`meta.total (${total}) differs from jobs returned (${raw.jobs.length})`);
    }
    return finishListing(listing);
  },

  presenceKeys(raw, { boardToken }): PresenceKeys {
    if (!isRecord(raw) || !Array.isArray(raw.jobs)) {
      throw new Error(`Greenhouse listing for board "${boardToken}" is not a { jobs: [...] } object`);
    }
    const keys = collectPresence(raw.jobs);
    const total = isRecord(raw.meta) ? raw.meta.total : undefined;
    if (typeof total === 'number' && total !== raw.jobs.length) keys.complete = false;
    return keys;
  },

  parseJobCheck(status, raw, { boardToken, externalId }): JobCheckResult {
    if (status === 404 || status === 410) return { outcome: 'not_found' };
    if (status < 200 || status >= 300) return { outcome: 'unknown' };
    const result = parseOne(raw, boardToken);
    if ('warning' in result || result.payload.externalId !== externalId) return { outcome: 'unknown' };
    return { outcome: 'live', payload: result.payload };
  },
};
