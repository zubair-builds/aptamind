import type { AtsProvider } from '../contracts/common';
import { ashbyAdapter } from './ashby';
import { greenhouseAdapter } from './greenhouse';
import { leverAdapter } from './lever';
import type { JobBoardAdapter } from './types';

export type {
  AdapterListing,
  JobBoardAdapter,
  JobCheckOutcome,
  JobCheckResult,
  PresenceKeys,
  SkippedEntry,
} from './types';
export { greenhouseAdapter } from './greenhouse';
export { leverAdapter } from './lever';
export { ashbyAdapter } from './ashby';
export { parseAggregatorFeed, AGGREGATOR_ADAPTER_VERSION } from './aggregator';
export { decodeEncodedHtml, htmlToText, normalizePeriod } from './shared';
export { apiBaseOfListingUrl, boardSourceIdentity, regionOfApiBase } from './regions';

/** Job-board adapters keyed by ATS provider. */
export const ADAPTERS: Record<AtsProvider, JobBoardAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
};

export function getAdapter(provider: AtsProvider): JobBoardAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`No job board adapter for provider "${String(provider)}"`);
  return adapter;
}
