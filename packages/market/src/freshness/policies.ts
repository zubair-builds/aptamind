import { DAY_MS, HOUR_MS } from '@aptamind/contracts';

/**
 * Freshness differs by data class (context §16). Each class declares how often it should be
 * refreshed/verified and when data becomes stale. Sources reference a class; jobs use
 * `job.active` for verification scheduling.
 */
export interface FreshnessPolicy {
  dataClass: string;
  description: string;
  /** Target interval between refreshes / verifications. */
  refreshEveryMs: number;
  /** Age after which the data is considered stale (surfaced in dashboards). */
  staleAfterMs: number;
}

export const FRESHNESS_POLICY_VERSION = 'freshness/1';

export const FRESHNESS_POLICIES: Record<string, FreshnessPolicy> = {
  'job.active': {
    dataClass: 'job.active',
    description: 'Live job postings',
    refreshEveryMs: 24 * HOUR_MS,
    staleAfterMs: 72 * HOUR_MS,
  },
  'source.ats_listing': {
    dataClass: 'source.ats_listing',
    description: 'ATS job board listings',
    refreshEveryMs: 6 * HOUR_MS,
    staleAfterMs: 36 * HOUR_MS,
  },
  'source.careers_page': {
    dataClass: 'source.careers_page',
    description: 'Careers pages (crawl)',
    refreshEveryMs: DAY_MS,
    staleAfterMs: 3 * DAY_MS,
  },
  'source.sponsor_register': {
    dataClass: 'source.sponsor_register',
    description: 'Government sponsor registers',
    refreshEveryMs: DAY_MS,
    staleAfterMs: 3 * DAY_MS,
  },
  'source.third_party_feed': {
    dataClass: 'source.third_party_feed',
    description: 'Third-party job feeds',
    refreshEveryMs: 12 * HOUR_MS,
    staleAfterMs: 3 * DAY_MS,
  },
  'company.careers': {
    dataClass: 'company.careers',
    description: 'Careers URL / ATS discovery',
    refreshEveryMs: 14 * DAY_MS,
    staleAfterMs: 45 * DAY_MS,
  },
  'company.firmographics': {
    dataClass: 'company.firmographics',
    description: 'Employee size, funding, stage',
    refreshEveryMs: 30 * DAY_MS,
    staleAfterMs: 90 * DAY_MS,
  },
  'company.remote_policy': {
    dataClass: 'company.remote_policy',
    description: 'Company remote policy',
    refreshEveryMs: 30 * DAY_MS,
    staleAfterMs: 90 * DAY_MS,
  },
};

export function freshnessPolicy(dataClass: string): FreshnessPolicy {
  const p = FRESHNESS_POLICIES[dataClass];
  if (!p) throw new Error(`Unknown freshness data class ${dataClass}`);
  return p;
}

export function nextVerificationDue(lastConfirmedAt: Date, dataClass = 'job.active'): Date {
  return new Date(lastConfirmedAt.getTime() + freshnessPolicy(dataClass).refreshEveryMs);
}
