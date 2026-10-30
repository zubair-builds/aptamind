import { z } from 'zod';

/** Normalised location. Country is ISO 3166-1 alpha-2 when known. */
export const locationSchema = z.object({
  text: z.string().optional(),
  city: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  country: z.string().length(2).nullable().optional(),
  kind: z.enum(['hq', 'office', 'registered', 'job', 'unknown']).optional(),
});
export type Location = z.infer<typeof locationSchema>;

export const SOURCE_CATEGORIES = [
  'company_universe',
  'job_source',
  'signal_source',
  'manual_import',
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

export const ATS_PROVIDERS = ['greenhouse', 'ashby', 'lever'] as const;
export type AtsProvider = (typeof ATS_PROVIDERS)[number];

/**
 * The closed set of job-source providers (PR #11 re-verify #7 LOW-1, DECISION_LOG "Job
 * verification apply is monotonic and re-validated"). Registration trims and lower-cases the
 * provider (`normalizeProviderKey`) and refuses a `job_source` whose provider is outside this set.
 * Stored sources are read tolerantly: a job source whose stored provider is outside the set is
 * not migrated, but its copies are never authoritative (and it is reported at start-up).
 */
export const JOB_SOURCE_PROVIDERS = [...ATS_PROVIDERS, 'careers_page', 'aggregator', 'manual'] as const;
export type JobSourceProvider = (typeof JOB_SOURCE_PROVIDERS)[number];

/** Providers that republish other employers' postings: their copies are never authoritative. */
export const THIRD_PARTY_PROVIDERS: readonly JobSourceProvider[] = ['aggregator'];

/** Provider keys are compared trimmed and lower-cased (`' Aggregator '` is `aggregator`). */
export function normalizeProviderKey(provider: string): string {
  return provider.trim().toLowerCase();
}

/**
 * Exactly a member of `JOB_SOURCE_PROVIDERS`. Exact on purpose: input is normalised before this
 * check, and a STORED provider that is not exactly a member (`Greenhouse`, `adzuna-feed`) is not
 * one the connectors dispatch on, so it is unrecognised.
 */
export function isJobSourceProvider(provider: string): provider is JobSourceProvider {
  return (JOB_SOURCE_PROVIDERS as readonly string[]).includes(provider);
}

/** Third-party by nature (aggregator), whatever authority tier the source or copy carries. */
export function isThirdPartyProvider(provider: string): boolean {
  return (THIRD_PARTY_PROVIDERS as readonly string[]).includes(normalizeProviderKey(provider));
}

export const atsRefSchema = z.object({
  provider: z.enum(ATS_PROVIDERS),
  boardToken: z.string().min(1),
});
export type AtsRef = z.infer<typeof atsRefSchema>;
