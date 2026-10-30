import { z } from 'zod';
import {
  cleanString,
  decodeEncodedHtml,
  describeIssues,
  finalizePayload,
  htmlToText,
  isRecord,
  locationsFromStrings,
  normalizePeriod,
  rawId,
  skipMalformed,
  toIsoDate,
  type JobPayloadInput,
} from './shared';
import type { AdapterListing } from './types';

/**
 * Generic third-party aggregator feed. Aggregators are weak, secondary evidence: they syndicate
 * official postings (referenced by `apply_url`) and may disagree with them, so they never claim
 * completeness.
 */

export const AGGREGATOR_ADAPTER_VERSION = 'aggregator@1';

const feedJobSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]),
  company: z.string().nullish(),
  title: z.string().trim().min(1),
  location: z.union([z.string(), z.array(z.string())]).nullish(),
  remote: z.boolean().nullish(),
  employment_type: z.string().nullish(),
  salary: z
    .object({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: z.string().nullish(),
      period: z.string().nullish(),
      text: z.string().nullish(),
    })
    .nullish(),
  url: z.string().nullish(),
  apply_url: z.string().nullish(),
  posted_at: z.string().nullish(),
  description: z.string().nullish(),
});
type FeedJob = z.infer<typeof feedJobSchema>;

function mapJob(job: FeedJob): JobPayloadInput {
  const descriptionHtml = job.description ? decodeEncodedHtml(job.description) : null;
  const locations = Array.isArray(job.location) ? job.location : [job.location];
  const salary = job.salary;
  return {
    externalId: String(job.id),
    title: job.title,
    companyName: cleanString(job.company),
    descriptionHtml,
    descriptionText: descriptionHtml ? htmlToText(descriptionHtml) : null,
    locations: locationsFromStrings(locations),
    workplaceType: job.remote ? 'remote' : null,
    employmentTypeText: cleanString(job.employment_type),
    postingUrl: cleanString(job.url),
    // The official ATS posting the aggregator syndicates; the key link for job entity resolution.
    applyUrl: cleanString(job.apply_url),
    publishedAt: toIsoDate(job.posted_at),
    compensation: salary
      ? {
          text: cleanString(salary.text),
          min: salary.min ?? null,
          max: salary.max ?? null,
          currency: cleanString(salary.currency)?.toUpperCase() ?? null,
          period: normalizePeriod(salary.period),
        }
      : null,
    provider: { name: 'aggregator', boardToken: null },
  };
}

/** Parse a `{ source, generated_at, jobs: [...] }` aggregator feed. Throws when the top-level shape is wrong. */
export function parseAggregatorFeed(raw: unknown): AdapterListing {
  if (!isRecord(raw) || !Array.isArray(raw.jobs)) {
    throw new Error('Aggregator feed is not a { jobs: [...] } object');
  }
  const listing: AdapterListing = { jobs: [], skipped: [], complete: false, warnings: [] };
  raw.jobs.forEach((entry: unknown, index) => {
    const locator = `/jobs/${index}`;
    const parsed = feedJobSchema.safeParse(entry);
    if (!parsed.success) {
      skipMalformed(
        listing,
        entry,
        locator,
        `skipped malformed job (id ${rawId(entry)}): ${describeIssues(parsed.error)}`,
      );
      return;
    }
    const result = finalizePayload(mapJob(parsed.data));
    if (!result.ok)
      skipMalformed(listing, entry, locator, `skipped job ${String(parsed.data.id)}: ${result.warning}`);
    else listing.jobs.push({ payload: result.payload, locator });
  });
  return listing;
}
