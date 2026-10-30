import type { AtsProvider } from '../contracts/common';
import type { JobObservationPayload } from '../contracts/observations';

/**
 * A listing entry the adapter did not map to an observation. It is still ON the board, so its
 * record is never evidence of absence: `externalId` (when the raw entry has a usable id) counts
 * as seen. `malformed`: the entry failed the provider schema or the observation contract (also
 * reported in `warnings`); `unlisted`: the provider marks it hidden from the public board (Ashby
 * `isListed: false`) — a provider state, not a parse problem.
 */
export interface SkippedEntry {
  externalId: string | null;
  kind: 'malformed' | 'unlisted';
  /** JSON pointer into the raw payload. */
  locator: string;
  /** ≤ 300 chars. */
  reason: string;
}

/** Result of parsing one job-board listing response. */
export interface AdapterListing {
  /** `locator` is a JSON pointer into the raw payload, e.g. `/jobs/3`. */
  jobs: Array<{ payload: JobObservationPayload; locator: string }>;
  /** Entries on the board that were not mapped (see {@link SkippedEntry}); never absences. */
  skipped: SkippedEntry[];
  /**
   * true when the listing is a complete snapshot of the board's current open jobs (so absence is
   * meaningful). Adapters finish with `finishListing`, which clears it when more than 10 % of the
   * entries are malformed or a malformed entry has no usable id.
   */
  complete: boolean;
  warnings: string[];
}

/**
 * The ids on a board, read without mapping any entry (OPS-2). Used only to confirm presence
 * when the listing bytes match a snapshot that already went through the full parse.
 */
export interface PresenceKeys {
  /** Ids of entries on the public board (mapped or malformed in a full parse). */
  listed: string[];
  /** Ids the provider hides from the public board (Ashby `isListed: false`). */
  unlisted: string[];
  /** Entries without a usable id. */
  anonymous: number;
  /** false when the response itself says it is truncated (Greenhouse `meta.total`). */
  complete: boolean;
}

export type JobCheckOutcome = 'live' | 'not_found' | 'unknown';

export interface JobCheckResult {
  outcome: JobCheckOutcome;
  payload?: JobObservationPayload;
  /**
   * Board-derived checks only (the check read the whole board, e.g. Ashby): how many entries the
   * board had (mapped + skipped). The caller gates a `not_found` on it against the source's
   * listing baseline (`boardDerivedNotFoundGate`, ruling L1).
   */
  boardEntries?: number;
}

/**
 * Translates one ATS provider's public job-board API into JobObservationPayloads.
 * Adapters are pure: fetching is the caller's job, so raw responses can be snapshotted first.
 */
export interface JobBoardAdapter {
  readonly provider: AtsProvider;
  readonly adapterVersion: string;
  /**
   * The provider's public API bases by region (M6.3). `default` is the host used when a board's
   * region is unknown; regional hosts (e.g. `eu`) serve the same API shape for boards hosted
   * there — and answer 404 for boards hosted elsewhere, so the region must never be guessed.
   */
  readonly apiBases: { readonly default: string } & Readonly<Record<string, string>>;
  /** Listing endpoint of a board on `apiBase` (default: `apiBases.default`). */
  listingUrl(boardToken: string, apiBase?: string): string;
  /** URL used to verify one job is still live (provider API endpoint when one exists), on `apiBase`. */
  jobUrl(boardToken: string, externalId: string, apiBase?: string): string;
  /** Throws when `raw` is not the provider's expected top-level shape (a source failure, not "zero jobs"). */
  parseListing(raw: unknown, ctx: { boardToken: string }): AdapterListing;
  /** Cheap id-only read of a listing. Throws on the same wrong top-level shape as parseListing. */
  presenceKeys(raw: unknown, ctx: { boardToken: string }): PresenceKeys;
  /** Interpret the response of jobUrl(). */
  parseJobCheck(
    status: number,
    raw: unknown,
    ctx: { boardToken: string; externalId: string },
  ): JobCheckResult;
}
