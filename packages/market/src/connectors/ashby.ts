import { z } from 'zod';
import type { JobObservationPayload } from '../contracts/observations';
import {
  cleanString,
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

/** Ashby public Posting API (`api.ashbyhq.com/posting-api/job-board`). */

/** Ashby has a single public API host. */
const API_BASES = { default: 'https://api.ashbyhq.com/posting-api/job-board' } as const;

const postalAddressSchema = z
  .object({
    postalAddress: z
      .object({
        addressLocality: z.string().nullish(),
        addressRegion: z.string().nullish(),
        addressCountry: z.string().nullish(),
      })
      .nullish(),
  })
  .nullish();

const jobSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1),
  department: z.string().nullish(),
  team: z.string().nullish(),
  employmentType: z.string().nullish(),
  location: z.string().nullish(),
  secondaryLocations: z.array(z.object({ location: z.string().nullish() })).nullish(),
  address: postalAddressSchema,
  isRemote: z.boolean().nullish(),
  workplaceType: z.string().nullish(),
  publishedAt: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  jobUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  isListed: z.boolean().nullish(),
  compensation: z
    .object({
      compensationTierSummary: z.string().nullish(),
      summaryComponents: z
        .array(
          z.object({
            compensationType: z.string().nullish(),
            interval: z.string().nullish(),
            currencyCode: z.string().nullish(),
            minValue: z.number().nullish(),
            maxValue: z.number().nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});
type AshbyJob = z.infer<typeof jobSchema>;

const WORKPLACE: Record<string, JobObservationPayload['workplaceType']> = {
  remote: 'remote',
  hybrid: 'hybrid',
  onsite: 'onsite',
};

const EMPLOYMENT_TYPE: Record<string, string> = {
  FullTime: 'Full-time',
  PartTime: 'Part-time',
  Intern: 'Intern',
  Contract: 'Contract',
  Temporary: 'Temporary',
};

function workplaceType(job: AshbyJob): JobObservationPayload['workplaceType'] {
  const flag = WORKPLACE[(job.workplaceType ?? '').toLowerCase()];
  if (flag) return flag;
  // Older boards only expose `isRemote`; false does not imply on-site.
  return job.isRemote ? 'remote' : null;
}

function compensation(job: AshbyJob): JobPayloadInput['compensation'] {
  const comp = job.compensation;
  if (!comp) return null;
  const salary = comp.summaryComponents?.find((c) => c.compensationType === 'Salary');
  const text = cleanString(comp.compensationTierSummary);
  if (!salary && !text) return null;
  return {
    text,
    min: salary?.minValue ?? null,
    max: salary?.maxValue ?? null,
    currency: cleanString(salary?.currencyCode)?.toUpperCase() ?? null,
    period: normalizePeriod(salary?.interval),
  };
}

function mapJob(job: AshbyJob, boardToken: string): JobPayloadInput {
  const locations = locationsFromStrings([
    job.location,
    ...(job.secondaryLocations ?? []).map((l) => l.location),
  ]);
  const address = job.address?.postalAddress;
  const primary = locations[0];
  if (primary && address) {
    locations[0] = {
      ...primary,
      ...(cleanString(address.addressLocality) ? { city: cleanString(address.addressLocality) } : {}),
      ...(cleanString(address.addressRegion) ? { region: cleanString(address.addressRegion) } : {}),
    };
  }
  const descriptionHtml = cleanString(job.descriptionHtml);
  return {
    externalId: job.id,
    requisitionId: null,
    title: job.title,
    descriptionHtml,
    descriptionText:
      cleanString(job.descriptionPlain) ?? (descriptionHtml ? htmlToText(descriptionHtml) : null),
    locations,
    workplaceType: workplaceType(job),
    employmentTypeText: job.employmentType
      ? (EMPLOYMENT_TYPE[job.employmentType] ?? job.employmentType)
      : null,
    department: cleanString(job.department),
    team: cleanString(job.team),
    postingUrl: cleanString(job.jobUrl),
    applyUrl: cleanString(job.applyUrl),
    publishedAt: toIsoDate(job.publishedAt),
    compensation: compensation(job),
    provider: { name: 'ashby', boardToken },
  };
}

type ParsedEntry = { payload: JobObservationPayload } | { warning: string } | { unlisted: string };

function parseOne(raw: unknown, boardToken: string): ParsedEntry {
  const parsed = jobSchema.safeParse(raw);
  if (!parsed.success)
    return { warning: `skipped malformed job (id ${rawId(raw)}): ${describeIssues(parsed.error)}` };
  if (parsed.data.isListed === false) return { unlisted: parsed.data.id };
  const result = finalizePayload(mapJob(parsed.data, boardToken));
  if (!result.ok) return { warning: `skipped job ${parsed.data.id}: ${result.warning}` };
  return { payload: result.payload };
}

function listingUrl(boardToken: string, apiBase: string = API_BASES.default): string {
  return onBase(apiBase, `${encodeURIComponent(boardToken)}?includeCompensation=true`);
}

function jobsArray(raw: unknown, boardToken: string): unknown[] {
  if (!isRecord(raw) || !Array.isArray(raw.jobs)) {
    throw new Error(`Ashby job board "${boardToken}" response is not a { jobs: [...] } object`);
  }
  return raw.jobs;
}

function parseBoard(raw: unknown, boardToken: string): AdapterListing {
  const listing: AdapterListing = { jobs: [], skipped: [], complete: true, warnings: [] };
  jobsArray(raw, boardToken).forEach((entry, index) => {
    const locator = `/jobs/${index}`;
    const result = parseOne(entry, boardToken);
    if ('warning' in result) skipMalformed(listing, entry, locator, result.warning);
    // Hidden from the public board but still open: seen, and not a parse problem.
    else if ('unlisted' in result)
      listing.skipped.push({ externalId: result.unlisted, kind: 'unlisted', locator, reason: 'unlisted' });
    else listing.jobs.push({ payload: result.payload, locator });
  });
  return finishListing(listing);
}

export const ashbyAdapter: JobBoardAdapter = {
  provider: 'ashby',
  adapterVersion: 'ashby@1',

  apiBases: API_BASES,

  listingUrl,

  /** Ashby has no public single-job endpoint; liveness is checked against the full listing. */
  jobUrl(boardToken, _externalId, apiBase) {
    return listingUrl(boardToken, apiBase);
  },

  parseListing(raw, { boardToken }): AdapterListing {
    return parseBoard(raw, boardToken);
  },

  presenceKeys(raw, { boardToken }): PresenceKeys {
    return collectPresence(jobsArray(raw, boardToken), (entry) => entry.isListed === false);
  },

  /**
   * The check reads the whole board, so `not_found` needs positive proof that the job is gone:
   * the board parsed as a complete listing (`finishListing`: no id-less malformed entry, ≤ 10 %
   * malformed) that neither maps nor skips the job's id. A shape drift, an unparseable or
   * skipped entry, or any other anomaly is `unknown` (PR #11 A-H1). An EMPTY board is a
   * `not_found` with `boardEntries: 0`: whether it counts is the caller's board gate
   * (`boardDerivedNotFoundGate`) — only once the empty listing has been applied (baseline 0, no
   * hold); a glitch against a non-empty baseline stays inconclusive.
   */
  parseJobCheck(status, raw, { boardToken, externalId }): JobCheckResult {
    if (status < 200 || status >= 300) return { outcome: 'unknown' };
    let listing: AdapterListing;
    try {
      listing = parseBoard(raw, boardToken);
    } catch {
      return { outcome: 'unknown' };
    }
    const live = listing.jobs.find((j) => j.payload.externalId === externalId);
    if (live) return { outcome: 'live', payload: live.payload };
    // Present but unlisted or malformed: exists, cannot be confirmed as a live public posting.
    if (listing.skipped.some((s) => s.externalId === externalId)) return { outcome: 'unknown' };
    if (!listing.complete) return { outcome: 'unknown' };
    return { outcome: 'not_found', boardEntries: listing.jobs.length + listing.skipped.length };
  },
};
