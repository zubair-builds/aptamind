import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type Actor, artifactRefSchema } from '@aptamind/contracts';
import { HttpError, isRetryableStatus } from '@aptamind/net';
import {
  type CapabilityContext,
  defineCapability,
  isRetryable,
  recordSetSchema,
  RetryableError,
  TerminalError,
} from '@aptamind/workflow-sdk';
import { AI_GATEWAY, NET_CLIENT } from '@aptamind/workflow-nodes';
import { ATS_PROVIDERS, type AtsProvider } from '../contracts/common';
import { type JobObservationPayload, jobObservationPayloadSchema } from '../contracts/observations';
import {
  type AdapterListing,
  AGGREGATOR_ADAPTER_VERSION,
  getAdapter,
  parseAggregatorFeed,
  type PresenceKeys,
} from '../connectors';
import { extractJsonLdJobPostings } from '../discovery';
import { htmlToText } from '../enrichment';
import { MARKET, type MarketDomain } from '../market-domain';
import type { CopyBoard } from '../jobs/job.schema';
import { copyBoardSchema } from '../jobs/job.schema';
import { findRegisterCsvLink, UK_SPONSOR_PUBLICATION_URL } from '../sources/providers/uk-sponsor-register';
import type { SnapshotDoc } from '../observations/schemas';
import { backoffUntil, FETCH_RETRY } from '../sources/schedule-spread';
import type { SourceDoc } from '../sources/source.schema';
import { boardOfSource } from '../sources/source-standing';
import { JOB_POSTING_EXTRACT_PROMPT, jobPostingExtractSchema } from './ai-tasks';
import { isUploadOnly } from '../sources/upload-only';

function classify(err: unknown): Error {
  if (err instanceof HttpError)
    return err.retryable ? new RetryableError(err.message) : new TerminalError(err.message);
  return err as Error;
}

/**
 * Acquire a raw snapshot for a source: fetch the URL (SSRF-safe) and store the bytes as a
 * content-addressed artifact + snapshot, or — when `snapshotId` is given — reuse an existing
 * snapshot so the same data can be reprocessed without refetching.
 */
export const acquireSnapshot = defineCapability({
  type: 'market.acquire_snapshot',
  version: 1,
  title: 'Acquire Source Snapshot',
  description:
    'Fetches a source URL into an immutable snapshot, or reuses an existing snapshot for reprocessing.',
  category: 'acquisition',
  inputSchema: z.object({
    sourceId: z.string(),
    url: z.string().url().nullable().optional(),
    snapshotId: z.string().nullable().optional(),
  }),
  outputSchema: z.object({
    snapshotId: z.string(),
    artifact: artifactRefSchema,
    unchanged: z.boolean(),
    reprocessing: z.boolean(),
    url: z.string().nullable(),
    httpStatus: z.number().int().nullable(),
    /** Source chronology of this snapshot (its fetch time; unchanged by reprocessing). */
    fetchedAt: z.string().optional(),
  }),
  configSchema: z.object({
    maxBytes: z
      .number()
      .int()
      .positive()
      .default(200 * 1024 * 1024),
    timeoutMs: z.number().int().positive().default(120_000),
  }),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    queue: 'io',
    defaultTimeoutMs: 10 * 60_000,
    idempotencyProof:
      'Snapshot id = hash(source, sha256 of bytes) and the artifact is content-addressed; a re-fetch within the same run re-uses both and does not count again (fetchCount is per run).',
  },
  async execute(ctx, input, config) {
    const market = ctx.services.get(MARKET);
    const source = await market.sources.get(input.sourceId);
    if (input.snapshotId) {
      const snap = await market.observations.getSnapshot(input.snapshotId);
      if (snap.sourceId !== source._id)
        throw new TerminalError(`Snapshot ${snap._id} belongs to another source`);
      ctx.log.info('reprocessing existing snapshot', { snapshotId: snap._id });
      return {
        snapshotId: snap._id,
        artifact: snap.artifact,
        unchanged: true,
        reprocessing: true,
        url: snap.url ?? null,
        httpStatus: snap.httpStatus ?? null,
        fetchedAt: snap.lastFetchedAt.toISOString(),
      };
    }
    assertMayFetch(source);
    const url = input.url ?? source.endpoint.url;
    if (!url) throw new TerminalError(`Source ${source.key} has no URL to fetch`);
    await market.sources.recordAttempt(source._id, ctx.runId);
    try {
      const res = await ctx.services
        .get(NET_CLIENT)
        .request({ url, timeoutMs: config.timeoutMs, maxBytes: config.maxBytes, signal: ctx.signal });
      if (!res.ok) {
        const msg = `HTTP ${res.status} fetching ${res.url}`;
        throw isRetryableStatus(res.status) ? new RetryableError(msg) : new TerminalError(msg);
      }
      const mime = res.contentType.split(';')[0]?.trim() || 'application/octet-stream';
      const artifact = await ctx.artifacts.put(res.body, mime, { sourceId: source._id });
      const { snapshot, unchanged } = await market.observations.recordSnapshot({
        sourceId: source._id,
        artifact,
        url: res.url,
        httpStatus: res.status,
        contentType: res.contentType,
        runId: ctx.runId,
        via: 'http',
      });
      ctx.log.info('snapshot stored', { snapshotId: snapshot._id, bytes: artifact.size, unchanged });
      return {
        snapshotId: snapshot._id,
        artifact,
        unchanged,
        reprocessing: false,
        url: res.url,
        httpStatus: res.status,
        fetchedAt: snapshot.lastFetchedAt.toISOString(),
      };
    } catch (err) {
      await market.sources.recordFailure(source._id, (err as Error).message, ctx.runId);
      throw classify(err);
    }
  },
});

/**
 * Upload-only sources never fetch (their files must pass the provider's checks before storage):
 * every fetching Market capability refuses them, whatever workflow a run was started with.
 */
function assertMayFetch(source: { key: string; provider: string }): void {
  if (isUploadOnly(source.provider))
    throw new TerminalError(
      `Source ${source.key} is upload-only: nothing is fetched for it; run its import with an uploaded snapshotId`,
    );
}

/** Locate the current CSV on the gov.uk publication page (its URL changes with each update). */
export const locateSponsorRegisterCsv = defineCapability({
  type: 'market.locate_sponsor_register_csv',
  version: 1,
  title: 'Locate UK Sponsor Register CSV',
  description:
    'Finds the current register CSV link on the gov.uk publication page (skipped when reprocessing a snapshot).',
  category: 'acquisition',
  inputSchema: z.object({
    sourceId: z.string(),
    snapshotId: z.string().nullable().optional(),
    csvUrl: z.string().url().nullable().optional(),
  }),
  outputSchema: z.object({
    csvUrl: z.string().nullable(),
    skipped: z.boolean(),
    pageUrl: z.string().nullable(),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'pure',
    sideEffects: false,
    queue: 'io',
    defaultTimeoutMs: 120_000,
  },
  async execute(ctx, input) {
    const market = ctx.services.get(MARKET);
    const source = await market.sources.get(input.sourceId);
    assertMayFetch(source);
    if (input.snapshotId) return { csvUrl: null, skipped: true, pageUrl: null };
    if (input.csvUrl) return { csvUrl: input.csvUrl, skipped: false, pageUrl: null };
    const pageUrl = source.endpoint.url ?? UK_SPONSOR_PUBLICATION_URL;
    try {
      const res = await ctx.services.get(NET_CLIENT).getOk({ url: pageUrl, signal: ctx.signal });
      const csvUrl = findRegisterCsvLink(new TextDecoder().decode(res.body), res.url);
      if (!csvUrl) {
        await market.sources.recordFailure(source._id, 'CSV link not found on publication page', ctx.runId);
        throw new TerminalError(`No register CSV link found on ${pageUrl}`);
      }
      return { csvUrl, skipped: false, pageUrl: res.url };
    } catch (err) {
      if (!(err instanceof TerminalError))
        await market.sources.recordFailure(source._id, (err as Error).message, ctx.runId);
      throw classify(err);
    }
  },
});

export const listingItemSchema = z.object({
  payload: jobObservationPayloadSchema,
  locator: z.string(),
  /** Set when the payload came from AI extraction (provenance for Law H). */
  ai: z.object({ provider: z.string(), model: z.string(), promptVersion: z.string() }).optional(),
});

const skippedEntrySchema = z.object({
  externalId: z.string().nullable(),
  kind: z.enum(['malformed', 'unlisted']),
  locator: z.string(),
  reason: z.string(),
});

const fetchJobBoardInput = z.object({ sourceId: z.string(), snapshotId: z.string().nullable().optional() });
type FetchJobBoardInput = z.infer<typeof fetchJobBoardInput>;

const fetchJobBoardExecution = {
  retryable: true,
  idempotency: 'natural',
  sideEffects: true,
  queue: 'io',
  defaultTimeoutMs: 5 * 60_000,
} as const;

/** How many warnings a `parser_failure` review carries as a sample. */
const WARNING_SAMPLE = 5;

/** The source's OPS-2 listing stamp. */
type ListingStamp = NonNullable<SourceDoc['health']['listingStamp']>;

/** A listing read for parsing: fetched, re-served by a 304, or reloaded from a stored snapshot. */
interface ListingAcquisition {
  source: SourceDoc;
  snapshotId: string;
  artifactId: string;
  /** sha256 of the listing bytes. */
  contentHash: string;
  raw: unknown;
  fetchedAt: Date;
  /**
   * The board this listing was read from, captured when the fetch STARTS (the source was read
   * just before) and carried through the output to ingest and finalize (DECISION_LOG 6a01b36): an
   * endpoint PATCH while the fetch is in flight cannot relabel what it read. Reprocessing uses
   * the board the snapshot's fetch recorded (null — unknown — for snapshots stored before it).
   */
  board: CopyBoard | null;
  /**
   * A real acquisition (a fetch, or the first processing of an operator upload): only these change
   * source health. Reprocessing a fetched snapshot never does (LOW-D).
   */
  acquired: boolean;
  /** HTTP fetches only: the URL requested and the response validators (OPS-2). */
  http?: { url: string; etag?: string; lastModified?: string; notModified: boolean };
}

/** A failed listing fetch or parse, after it was recorded on the source. */
interface ListingFailure {
  err: unknown;
  failedAt: Date;
  status?: number;
  retryAfterMs?: number;
}

interface AcquireOptions {
  /** OPS-2: send this stamp's validators (`If-None-Match` / `If-Modified-Since`). */
  conditional?: ListingStamp | null;
  /**
   * OPS-2 (M3): when the provider host is cooling down (another board's Retry-After) and no
   * request was sent, throw `HostCoolingDown` and record nothing on the source.
   */
  deferWhenHostBusy?: boolean;
  /** OPS-2: called after a failure is recorded; may replace the error the step throws. */
  onFailure?: (failure: ListingFailure) => Promise<Error | undefined>;
}

/** No request was sent: the provider host is cooling down for every board on it (M3). */
class HostCoolingDown extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostCoolingDown';
  }
}

/**
 * The net client refused to send the request because the host is cooling down or no request
 * slot freed up in time. Foundation's client marks this only as a status-less HttpError: a
 * host cool-down carries the wait as `retryAfterMs`, a slot wait time-out names the slot.
 */
function hostBusy(err: unknown): err is HttpError {
  return (
    err instanceof HttpError &&
    err.status === undefined &&
    (err.retryAfterMs !== undefined || /request slot timed out/.test(err.message))
  );
}

/** The listing URL of a job source: an explicit endpoint URL (e.g. a regional host) wins. */
function listingUrlOf(source: SourceDoc): string | undefined {
  const isAts = (ATS_PROVIDERS as readonly string[]).includes(source.provider);
  return (
    source.endpoint.url ??
    (isAts
      ? getAdapter(source.provider as AtsProvider).listingUrl(source.endpoint.boardToken ?? '')
      : undefined)
  );
}

/**
 * Fetch (or reload a stored snapshot of) one job source listing. A failed fetch is a *source
 * failure*: it is recorded on the source and never interpreted as "zero jobs".
 */
async function acquireListing(
  ctx: CapabilityContext,
  source: SourceDoc,
  input: FetchJobBoardInput,
  opts: AcquireOptions = {},
): Promise<ListingAcquisition> {
  const market = ctx.services.get(MARKET);
  const provider = source.provider;
  const isAts = (ATS_PROVIDERS as readonly string[]).includes(provider);
  if (input.snapshotId) {
    const snap = await market.observations.getSnapshot(input.snapshotId);
    // An upload is acquired by the first run that processes it; any later run is a reprocess.
    const acquired =
      snap.via === 'upload' && (await market.observations.claimUploadAcquisition(snap._id, ctx.runId));
    // Reprocessing: the listing describes the world at its (last) fetch time, not now.
    if (acquired) await market.sources.recordFetch(source._id, snap.lastFetchedAt, true, ctx.runId);
    return {
      source,
      snapshotId: snap._id,
      artifactId: snap.artifact.artifactId,
      contentHash: snap.artifact.sha256,
      raw: JSON.parse(await ctx.artifacts.readText(snap.artifact)),
      fetchedAt: snap.lastFetchedAt,
      board: snap.fetchBoard ?? null,
      acquired,
    };
  }
  assertMayFetch(source);
  const board = boardOfSource(source);
  const url = listingUrlOf(source);
  if (!url || (isAts && !source.endpoint.boardToken))
    throw new TerminalError(`Source ${source.key} lacks a board token / URL`);
  const net = ctx.services.get(NET_CLIENT);
  // The attempt is recorded once a request was sent, or failed for any other reason (M3).
  let attempted = false;
  const recordAttempt = async () => {
    if (attempted) return;
    attempted = true;
    await market.sources.recordAttempt(source._id, ctx.runId);
  };
  const fetchOnce = (stamp?: ListingStamp | null) =>
    net.request({
      url,
      headers: {
        accept: 'application/json',
        ...(stamp?.etag ? { 'if-none-match': stamp.etag } : {}),
        ...(stamp?.lastModified ? { 'if-modified-since': stamp.lastModified } : {}),
      },
      timeoutMs: 60_000,
      signal: ctx.signal,
    });
  const conditional = opts.conditional?.etag || opts.conditional?.lastModified ? opts.conditional : null;
  let status: number | undefined;
  let retryAfterMs: number | undefined;
  try {
    let res = await fetchOnce(conditional);
    await recordAttempt();
    let stored: SnapshotDoc | null = null;
    if (res.status === 304 && conditional) {
      // Not modified: the provider re-serves the stamped snapshot. If it is gone, ask again
      // without validators rather than fail.
      stored = await market.observations.snapshots.findOne({ _id: conditional.snapshotId });
      if (!stored) res = await fetchOnce(null);
    }
    status = res.status;
    retryAfterMs = res.retryAfterMs;
    if (!stored && !res.ok) {
      const msg = `HTTP ${res.status} from ${provider} listing`;
      throw new HttpError(msg, isRetryableStatus(res.status), res.status, undefined, res.retryAfterMs);
    }
    const artifact = stored
      ? stored.artifact
      : await ctx.artifacts.put(res.body, 'application/json', { sourceId: source._id });
    const { snapshot } = await market.observations.recordSnapshot({
      sourceId: source._id,
      artifact,
      url: res.url,
      httpStatus: res.status,
      contentType: res.contentType,
      runId: ctx.runId,
      via: 'http',
      board,
    });
    const text = stored ? await ctx.artifacts.readText(artifact) : new TextDecoder().decode(res.body);
    return {
      source,
      snapshotId: snapshot._id,
      artifactId: artifact.artifactId,
      contentHash: artifact.sha256,
      raw: JSON.parse(text),
      // The snapshot's fetch time identifies this observation of the listing (reprocessing reuses it).
      fetchedAt: snapshot.lastFetchedAt,
      board,
      acquired: true,
      http: {
        url,
        etag: res.headers.etag ?? (stored ? conditional?.etag : undefined),
        lastModified: res.headers['last-modified'] ?? (stored ? conditional?.lastModified : undefined),
        notModified: !!stored,
      },
    };
  } catch (err) {
    if (opts.deferWhenHostBusy && !attempted && hostBusy(err)) throw new HostCoolingDown(err.message);
    await recordAttempt();
    // The latest fetch first; the failure's health only while it is the latest (L-4).
    const failedAt = ctx.clock.now();
    await market.sources.recordFetch(source._id, failedAt, false, ctx.runId);
    await market.sources.recordFailure(source._id, (err as Error).message, ctx.runId, failedAt);
    if (err instanceof HttpError) {
      status ??= err.status;
      retryAfterMs ??= err.retryAfterMs;
    }
    const replaced = await opts.onFailure?.({ err, failedAt, status, retryAfterMs });
    throw replaced ?? classify(err);
  }
}

/** Map an acquired listing through its adapter (or the aggregator feed parser). */
async function parseAcquiredListing(
  ctx: CapabilityContext,
  acq: ListingAcquisition,
  opts: Pick<AcquireOptions, 'onFailure'> = {},
): Promise<AdapterListing> {
  const market = ctx.services.get(MARKET);
  const { source, snapshotId, artifactId, fetchedAt, acquired } = acq;
  const provider = source.provider;
  try {
    return (ATS_PROVIDERS as readonly string[]).includes(provider)
      ? getAdapter(provider as AtsProvider).parseListing(acq.raw, {
          boardToken: source.endpoint.boardToken ?? '',
        })
      : parseAggregatorFeed(acq.raw);
  } catch (err) {
    let replaced: Error | undefined;
    if (acquired) {
      const failedAt = ctx.clock.now();
      await market.sources.recordFetch(source._id, failedAt, false, ctx.runId);
      await market.sources.recordFailure(
        source._id,
        `parse failed: ${(err as Error).message}`,
        ctx.runId,
        failedAt,
      );
      // A shape the adapter cannot read fails for good: no retry would change the bytes.
      replaced = await opts.onFailure?.({ err: new TerminalError((err as Error).message), failedAt });
    }
    await market.reviews.raise({
      type: 'parser_failure',
      severity: 'medium',
      dedupeKey: `parser_failure:${source._id}`,
      entity: { kind: 'source', id: source._id },
      subject: `${source.name}: listing could not be parsed`,
      reason: (err as Error).message.slice(0, 500),
      evidence: [{ sourceId: source._id, snapshotId, artifactId, observedAt: fetchedAt }],
      context: { sourceId: source._id, snapshotId },
      allowedActions: ['retry', 'dismiss'],
    });
    throw replaced ?? new TerminalError(`Unexpected ${provider} response shape: ${(err as Error).message}`);
  }
}

/**
 * Fetch (or reload a stored snapshot) and parse one job source listing. A failed fetch or an
 * unexpected response shape is a *source failure*: it is recorded on the source, raised for
 * review, and never interpreted as "zero jobs".
 */
async function fetchAndParseListing(ctx: CapabilityContext, input: FetchJobBoardInput) {
  const market = ctx.services.get(MARKET);
  const source = await market.sources.get(input.sourceId);
  const acq = await acquireListing(ctx, source, input);
  const listing = await parseAcquiredListing(ctx, acq);
  const { snapshotId, artifactId, fetchedAt, board, acquired } = acq;
  await market.observations.setSnapshotItemCount(snapshotId, listing.jobs.length);
  const records = await ctx.records.write(listing.jobs, { sourceId: source._id });
  for (const w of listing.warnings.slice(0, 20)) ctx.log.warn(w);
  if (acquired && !input.snapshotId) await market.sources.recordFetch(source._id, fetchedAt, true, ctx.runId);
  return { source, snapshotId, artifactId, records, listing, fetchedAt, board, acquired };
}

/**
 * v1 (runs pinned to template versions before M6.1). Its finalizer cannot see skipped entries,
 * so any skipped entry makes the listing incomplete: a dropped entry can never become an absence.
 */
export const fetchJobBoardV1 = defineCapability({
  type: 'market.fetch_job_board',
  version: 1,
  title: 'Fetch Job Board',
  description:
    'Fetches a job source listing, snapshots it and maps it to shared JobObservation payloads.' +
    ' Changed in place in PR #11 (accepted exception, see streams/market.md): ' +
    'any skipped entry makes the listing incomplete (M6.1).',
  category: 'acquisition',
  inputSchema: fetchJobBoardInput,
  outputSchema: z.object({
    snapshotId: z.string(),
    artifactId: z.string(),
    records: recordSetSchema,
    count: z.number().int(),
    complete: z.boolean(),
    warnings: z.array(z.string()),
    fetchedAt: z.string(),
  }),
  configSchema: z.object({}),
  execution: {
    ...fetchJobBoardExecution,
    idempotencyProof:
      'Snapshot id = hash(source, sha256) and content-addressed artifact; the item record set is content-addressed; re-execution in the same run changes nothing.',
  },
  async execute(ctx, input) {
    const { source, snapshotId, artifactId, records, listing, fetchedAt } = await fetchAndParseListing(
      ctx,
      input,
    );
    return {
      snapshotId,
      artifactId,
      records,
      count: listing.jobs.length,
      complete: listing.complete && source.authority.listingIsComplete && listing.skipped.length === 0,
      warnings: listing.warnings.slice(0, 50),
      fetchedAt: fetchedAt.toISOString(),
    };
  },
});

/**
 * Fetch and parse an ATS job board (or third-party feed) through its provider adapter (v2, M6.1).
 * Entries the adapter drops are returned as `skipped` (the finalizer treats their ids as seen,
 * never absent); malformed entries and other parser warnings raise a low-severity
 * `parser_failure` review with counts and a sample, instead of only being logged.
 */
export const fetchJobBoard = defineCapability({
  type: 'market.fetch_job_board',
  version: 2,
  title: 'Fetch Job Board',
  description:
    'Fetches a job source listing, snapshots it, maps it to shared JobObservation payloads and reports entries it could not map.',
  category: 'acquisition',
  inputSchema: fetchJobBoardInput,
  outputSchema: z.object({
    snapshotId: z.string(),
    artifactId: z.string(),
    records: recordSetSchema,
    count: z.number().int(),
    /** Adapter completeness (including the malformed-entry rule) AND the source's `listingIsComplete`. */
    complete: z.boolean(),
    /**
     * Every entry on the board that was not mapped when the listing is complete (the finalizer
     * needs every id); capped at SKIPPED_CAP_WHEN_INCOMPLETE (unlisted first) when it is not.
     */
    skipped: z.array(skippedEntrySchema),
    warnings: z.array(z.string()),
    fetchedAt: z.string(),
    /** The board read, captured at fetch start (null: unknown). Carried to ingest and finalize. */
    board: copyBoardSchema.nullable().optional(),
    /** A real acquisition (fetch or upload), not a reprocess: only these change source health. */
    acquired: z.boolean().optional(),
  }),
  configSchema: z.object({}),
  execution: {
    ...fetchJobBoardExecution,
    idempotencyProof:
      'Snapshot id = hash(source, sha256) and content-addressed artifact; the item record set is content-addressed; the parser_failure review is raised on a dedupe key of (source, adapter version, malformed-entry set) (a re-execution re-uses the open item) and older open findings are dismissed with deterministic operation ids; re-execution in the same run changes nothing else.',
  },
  async execute(ctx, input) {
    const { source, snapshotId, artifactId, records, listing, fetchedAt, board, acquired } =
      await fetchAndParseListing(ctx, input);
    await reportParserWarnings(ctx, source, listing, { snapshotId, artifactId, fetchedAt });
    const complete = listing.complete && source.authority.listingIsComplete;
    return {
      snapshotId,
      artifactId,
      records,
      count: listing.jobs.length,
      complete,
      skipped: complete ? listing.skipped : capSkipped(listing.skipped),
      warnings: listing.warnings.slice(0, 50),
      fetchedAt: fetchedAt.toISOString(),
      board,
      acquired,
    };
  },
});

/**
 * Malformed entries and other parser warnings raise a low-severity `parser_failure` review with
 * counts and a sample (v2 and v3), instead of only being logged.
 */
async function reportParserWarnings(
  ctx: CapabilityContext,
  source: SourceDoc,
  listing: AdapterListing,
  at: { snapshotId: string; artifactId: string; fetchedAt: Date },
): Promise<void> {
  if (!listing.warnings.length) return;
  const market = ctx.services.get(MARKET);
  const { snapshotId, artifactId, fetchedAt } = at;
  const malformedEntries = listing.skipped.filter((e) => e.kind === 'malformed');
  const malformed = malformedEntries.length;
  const unlisted = listing.skipped.length - malformed;
  const entity = { kind: 'source' as const, id: source._id };
  const dedupeKey = parserFailureKey(source._id, adapterVersionOf(source.provider), malformedEntries);
  // The operator already dismissed this exact malformed set under this adapter version: the
  // same finding is not raised again (B-M4). A new set or adapter version is a new finding.
  // A system supersession is not an operator decision about the set (B LOW-2).
  const decided = await market.reviews.latestDecision(dedupeKey, entity, {
    excludeActorIds: [PARSER_SUPERSEDE_ACTOR.id],
  });
  if (decided?.status === 'dismissed') return;
  const { item } = await market.reviews.raise({
    type: 'parser_failure',
    severity: 'low',
    dedupeKey,
    entity,
    subject: malformed
      ? `${source.name}: ${malformed} listing entr${malformed === 1 ? 'y' : 'ies'} could not be mapped`
      : `${source.name}: listing parser warnings`,
    reason:
      `${listing.warnings.length} parser warning(s) on a listing of ${listing.jobs.length + listing.skipped.length} entries. ` +
      'Skipped entries are kept as seen (never closed); check the adapter against the stored snapshot.',
    evidence: [{ sourceId: source._id, snapshotId, artifactId, observedAt: fetchedAt }],
    context: {
      sourceId: source._id,
      snapshotId,
      entries: listing.jobs.length + listing.skipped.length,
      mapped: listing.jobs.length,
      malformed,
      unlisted,
      warnings: listing.warnings.length,
      complete: listing.complete,
      adapterVersion: adapterVersionOf(source.provider),
      sample: listing.warnings.slice(0, WARNING_SAMPLE).map((w) => w.slice(0, 300)),
    },
    allowedActions: ['retry', 'dismiss'],
  });
  await supersedeParserFailures(market, source._id, item._id, ctx.log);
}

/** What a full-path listing tells the finalizer to stamp (OPS-2); `clean` gates the stamp. */
export const listingStampCandidateSchema = z.object({
  contentHash: z.string(),
  adapterVersion: z.string(),
  url: z.string(),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  listed: z.number().int().min(0),
  clean: z.boolean(),
  /** Confirm path: the copies digest the fetch validated (the finalizer requires it unchanged). */
  copies: z.string().optional(),
});

/** One listed id on the confirm path (`fetch_job_board@3`): no payload, nothing to ingest. */
export const presenceItemSchema = z.object({ externalId: z.string() });

/** A Retry-After above this ends the run: retrying inside it would ignore the provider. */
export const RETRY_AFTER_TERMINAL_MS = 60_000;
/** Consecutive 404 listing runs after which one `source_anomaly` review is opened. */
export const NOT_FOUND_REVIEW_AFTER = 3;
/** The interval a backoff doubles when the source has no interval schedule (the ATS default). */
const DEFAULT_REFRESH_MINUTES = 360;

/**
 * OPS-2 failure bookkeeping, only once the run has failed for good (a terminal error, or the
 * last attempt of the fetch): defer the source's scheduled runs (interval × 2 per consecutive
 * failure, capped at 24 h; a longer Retry-After wins) and open one review on the third
 * consecutive 404. A retry inside the run is never deferred (H2). A long Retry-After ends the
 * run instead of retrying inside it.
 */
async function onListingFailure(
  ctx: CapabilityContext,
  source: SourceDoc,
  slot: Date | null,
  f: ListingFailure,
): Promise<Error | undefined> {
  const longRetryAfter = !!f.retryAfterMs && f.retryAfterMs > RETRY_AFTER_TERMINAL_MS;
  // Attempts restart per operator retry (a new "life" of maxAttempts).
  const lastAttempt = ctx.attempt % FETCH_RETRY.maxAttempts === 0;
  const final = longRetryAfter || lastAttempt || !isRetryable(classify(f.err), true);
  if (!final) return undefined;
  const market = ctx.services.get(MARKET);
  const failures = (await market.sources.get(source._id)).health.consecutiveFailures;
  const until = backoffUntil({
    base: slot ?? f.failedAt,
    failedAt: f.failedAt,
    intervalMinutes: source.schedule?.intervalMinutes ?? DEFAULT_REFRESH_MINUTES,
    failures: Math.max(1, failures),
    retryAfterMs: f.retryAfterMs,
  });
  const streak = await market.sources.recordFetchFailure(source._id, {
    fetchAt: f.failedAt,
    until,
    notFound: f.status === 404,
    runId: ctx.runId,
    keep: NOT_FOUND_REVIEW_AFTER,
  });
  // Only the run that brings the streak to the threshold opens it: later 404s of the same streak
  // never re-open a resolved review. The key names the streak's first run.
  if (f.status === 404 && streak.reached === NOT_FOUND_REVIEW_AFTER)
    await market.reviews.raise({
      type: 'source_anomaly',
      severity: 'medium',
      dedupeKey: `source_anomaly:${source._id}:board_not_found:${streak.runs[0]}`,
      entity: { kind: 'source', id: source._id },
      subject: `${source.name}: board listing not found ${NOT_FOUND_REVIEW_AFTER} times in a row`,
      reason:
        `The last ${NOT_FOUND_REVIEW_AFTER} listing fetches returned HTTP 404. The board may have moved or closed. ` +
        'The source stays enabled and backs off; disable it or fix its board token.',
      context: { sourceId: source._id, runIds: streak.runs, url: listingUrlOf(source) ?? null },
      allowedActions: ['confirm', 'dismiss'],
    });
  if (longRetryAfter)
    return new TerminalError(
      `${(f.err as Error).message}; Retry-After ${Math.round(f.retryAfterMs! / 1000)}s, deferred until ${until.toISOString()}`,
    );
  return undefined;
}

/** The stamp a fetch may short-circuit against, or null (OPS-2). */
function usableStamp(source: SourceDoc): ListingStamp | null {
  const stamp = source.health.listingStamp;
  if (!stamp || !(ATS_PROVIDERS as readonly string[]).includes(source.provider)) return null;
  if (!source.authority.listingIsComplete) return null;
  // The stamp describes the last finalised listing only: any listing finalised since (by an older
  // pinned version that keeps no stamp) moves `lastSnapshotId` away from it.
  if (stamp.snapshotId !== source.health.lastSnapshotId) return null;
  if (stamp.adapterVersion !== adapterVersionOf(source.provider)) return null;
  if (stamp.url !== listingUrlOf(source)) return null;
  if (!stamp.copies) return null;
  return stamp;
}

/**
 * Fetch a job board (v3, OPS-2): conditional request, unchanged-listing short-circuit and
 * source backoff. Paths:
 * - `deferred`: nothing is requested. Either the first attempt of a scheduled run inside the
 *   source's backoff, or the provider host is cooling down for another board on the first attempt
 *   (no attempt, failure or backoff is recorded on this source; a retry ends FAILED instead).
 * - `confirm`: the bytes equal the last clean listing (or the provider answered 304) and every
 *   listed id is a present copy: only the ids are read; the finalizer confirms presence and
 *   runs the listing policy; no per-job ingest.
 * - `full`: as v2 (map, report parser warnings, ingest every job).
 */
export const fetchJobBoardV3 = defineCapability({
  type: 'market.fetch_job_board',
  version: 3,
  title: 'Fetch Job Board',
  description:
    'Fetches a job board with conditional requests; an unchanged listing only confirms presence, a changed one is mapped in full; failures back the source off.',
  category: 'acquisition',
  inputSchema: fetchJobBoardInput.extend({
    /** Schedule trigger output: only `schedule` runs are deferred by a backoff. */
    triggerKind: z.string().nullable().optional(),
    scheduledFor: z.string().nullable().optional(),
  }),
  outputSchema: z.object({
    path: z.enum(['full', 'confirm', 'deferred']),
    snapshotId: z.string().nullable(),
    artifactId: z.string().nullable(),
    /** Listing items to ingest; empty on the `confirm` path. */
    records: recordSetSchema.nullable(),
    /** `confirm` path: the `{ externalId }` items whose presence the finalizer confirms. */
    present: recordSetSchema.nullable().optional(),
    count: z.number().int(),
    complete: z.boolean(),
    skipped: z.array(skippedEntrySchema),
    warnings: z.array(z.string()),
    fetchedAt: z.string().nullable(),
    board: copyBoardSchema.nullable().optional(),
    acquired: z.boolean().optional(),
    /** What the finalizer stamps when the listing turns out clean (null: never stamped). */
    stamp: listingStampCandidateSchema.nullable(),
    deferredUntil: z.string().nullable().optional(),
    /** Why a `deferred` run requested nothing. */
    deferredReason: z.enum(['source_backoff', 'host_cooling_down']).optional(),
  }),
  configSchema: z.object({}),
  execution: {
    ...fetchJobBoardExecution,
    idempotencyProof:
      'Snapshot id = hash(source, sha256) and content-addressed artifact; the item record set is content-addressed; parser_failure reviews as v2; backoff is written only by a final failure and only moves forward ($max); the 404 streak keeps the last run ids once each, so a re-execution in the same run adds nothing; the not-found review opens only when a run is newly added at the threshold and has a per-streak dedupe key; a deferral writes nothing.',
  },
  async execute(ctx, input) {
    const market = ctx.services.get(MARKET);
    const source = await market.sources.get(input.sourceId);
    const slot = input.scheduledFor ? new Date(input.scheduledFor) : null;
    const empty = {
      snapshotId: null,
      artifactId: null,
      records: null,
      count: 0,
      complete: false,
      skipped: [],
      warnings: [],
      fetchedAt: null,
      stamp: null,
    };
    const backoff = source.health.backoffUntil;
    // Only a first attempt: a retry (or operator retry) of this run is never deferred (H2).
    if (
      !input.snapshotId &&
      input.triggerKind === 'schedule' &&
      ctx.attempt === 1 &&
      backoff &&
      (slot ?? ctx.clock.now()) < backoff
    ) {
      ctx.log.info('scheduled run deferred by source backoff', { until: backoff.toISOString() });
      return {
        ...empty,
        path: 'deferred' as const,
        deferredUntil: backoff.toISOString(),
        deferredReason: 'source_backoff' as const,
      };
    }
    const stamp = input.snapshotId ? null : usableStamp(source);
    const onFailure = (f: ListingFailure) => onListingFailure(ctx, source, slot, f);
    let acq: ListingAcquisition;
    try {
      acq = await acquireListing(ctx, source, input, {
        conditional: stamp,
        onFailure,
        deferWhenHostBusy: true,
      });
    } catch (err) {
      if (!(err instanceof HostCoolingDown)) throw err;
      // A retry follows a failed request of this board: deferring would end the run COMPLETED.
      if (ctx.attempt > 1) throw new TerminalError(`Provider host is cooling down: ${err.message}`);
      // Another board's Retry-After cools the shared host: not this source's failure (M3).
      ctx.log.info('provider host is cooling down; nothing was requested and the run is deferred', {
        reason: err.message,
      });
      return {
        ...empty,
        path: 'deferred' as const,
        deferredUntil: null,
        deferredReason: 'host_cooling_down' as const,
      };
    }
    const { snapshotId, artifactId, fetchedAt, board, acquired } = acq;
    const isAts = (ATS_PROVIDERS as readonly string[]).includes(source.provider);
    const boardToken = source.endpoint.boardToken ?? '';

    if (stamp && acq.http && acq.contentHash === stamp.contentHash) {
      let keys: PresenceKeys | null = null;
      try {
        keys = getAdapter(source.provider as AtsProvider).presenceKeys(acq.raw, { boardToken });
      } catch {
        keys = null; // the full parse below reports the shape problem
      }
      if (
        keys?.complete &&
        keys.anonymous === 0 &&
        keys.listed.length === stamp.listed &&
        (await market.jobPipeline.presenceConfirmable(source._id, keys.listed, stamp.copies!))
      ) {
        await market.observations.setSnapshotItemCount(snapshotId, keys.listed.length);
        const present = await ctx.records.write(
          keys.listed.map((externalId) => ({ externalId })),
          { sourceId: source._id },
        );
        await market.sources.recordFetch(source._id, fetchedAt, true, ctx.runId);
        return {
          path: 'confirm' as const,
          snapshotId,
          artifactId,
          records: await ctx.records.write([], { sourceId: source._id }),
          present,
          count: keys.listed.length,
          complete: true,
          skipped: keys.unlisted.map((externalId) => ({
            externalId,
            kind: 'unlisted' as const,
            locator: '',
            reason: 'unlisted',
          })),
          warnings: [],
          fetchedAt: fetchedAt.toISOString(),
          board,
          acquired,
          stamp: {
            ...stampOf(acq, stamp.adapterVersion, keys.listed.length),
            clean: true,
            copies: stamp.copies!,
          },
        };
      }
    }

    const listing = await parseAcquiredListing(ctx, acq, { onFailure });
    await market.observations.setSnapshotItemCount(snapshotId, listing.jobs.length);
    const records = await ctx.records.write(listing.jobs, { sourceId: source._id });
    for (const w of listing.warnings.slice(0, 20)) ctx.log.warn(w);
    if (acquired && !input.snapshotId)
      await market.sources.recordFetch(source._id, fetchedAt, true, ctx.runId);
    await reportParserWarnings(ctx, source, listing, { snapshotId, artifactId, fetchedAt });
    const complete = listing.complete && source.authority.listingIsComplete;
    const malformed = listing.skipped.some((e) => e.kind === 'malformed');
    return {
      path: 'full' as const,
      snapshotId,
      artifactId,
      records,
      count: listing.jobs.length,
      complete,
      skipped: complete ? listing.skipped : capSkipped(listing.skipped),
      warnings: listing.warnings.slice(0, 50),
      fetchedAt: fetchedAt.toISOString(),
      board,
      acquired,
      // Only a fetched ATS listing that every later step can rely on byte for byte is stamped.
      stamp:
        acq.http && isAts
          ? {
              ...stampOf(acq, adapterVersionOf(source.provider), listing.jobs.length),
              clean: complete && !malformed,
            }
          : null,
    };
  },
});

function stampOf(acq: ListingAcquisition, adapterVersion: string, listed: number) {
  return {
    contentHash: acq.contentHash,
    adapterVersion,
    url: acq.http!.url,
    ...(acq.http?.etag ? { etag: acq.http.etag } : {}),
    ...(acq.http?.lastModified ? { lastModified: acq.http.lastModified } : {}),
    listed,
  };
}

/** Adapter version of a job source's parser (the aggregator feed parser for non-ATS feeds). */
function adapterVersionOf(provider: string): string {
  return (ATS_PROVIDERS as readonly string[]).includes(provider)
    ? getAdapter(provider as AtsProvider).adapterVersion
    : AGGREGATOR_ADAPTER_VERSION;
}

/**
 * Dedupe key of an unmappable-entries `parser_failure` (B-M4): one finding per source, adapter
 * version and SET of malformed entries (their ids, or JSON pointers when they have none). A
 * listing with warnings but no malformed entry (e.g. a count mismatch) is one finding per
 * source and adapter version.
 */
export function parserFailureKey(
  sourceId: string,
  adapterVersion: string,
  malformed: ReadonlyArray<{ externalId: string | null; locator: string }>,
): string {
  const ids = [...new Set(malformed.map((e) => e.externalId ?? `@${e.locator}`))].sort();
  const set = ids.length ? createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16) : 'none';
  return `parser_failure:${sourceId}:entries:${adapterVersion}:${set}`;
}

/**
 * A newer finding replaces the source's older open unmappable-entries findings: they are
 * dismissed as superseded (system actor, audited, deterministic operation id — a re-execution
 * resumes or skips). One being resolved by an operator right now is left to them.
 */
async function supersedeParserFailures(
  market: MarketDomain,
  sourceId: string,
  currentId: string,
  log: CapabilityContext['log'],
): Promise<void> {
  const older = await market.reviews.col
    .find(
      {
        'entity.kind': 'source',
        'entity.id': sourceId,
        status: 'open',
        type: 'parser_failure',
        dedupeKey: { $regex: `^parser_failure:${escapeRegex(sourceId)}:entries(:|$)` },
        _id: { $ne: currentId },
      },
      { projection: { _id: 1 } },
    )
    .toArray();
  for (const { _id } of older) {
    try {
      await market.reviewService.resolve(
        _id,
        { action: 'dismiss', reason: `Superseded by a newer parser finding (${currentId}).` },
        PARSER_SUPERSEDE_ACTOR,
        { operationId: `rop_superseded_${_id}` },
      );
    } catch (err) {
      log.warn('older parser_failure not superseded', { reviewItemId: _id, err: (err as Error).message });
    }
  }
}

const PARSER_SUPERSEDE_ACTOR = { kind: 'system', id: 'market-parser-findings' } as Actor;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** When the listing is incomplete no absence is applied: the skipped list is capped (unlisted first). */
export const SKIPPED_CAP_WHEN_INCOMPLETE = 200;

function capSkipped<T extends { kind: string }>(skipped: T[]): T[] {
  if (skipped.length <= SKIPPED_CAP_WHEN_INCOMPLETE) return skipped;
  const unlisted = skipped.filter((e) => e.kind === 'unlisted');
  const rest = skipped.filter((e) => e.kind !== 'unlisted');
  return [...unlisted, ...rest].slice(0, SKIPPED_CAP_WHEN_INCOMPLETE);
}

/**
 * Extract job postings from crawled pages: deterministic schema.org JobPosting JSON-LD first;
 * structured AI extraction only as a fallback (schema-validated, provenance recorded on the
 * observation) when AI is configured and enabled for the source.
 */
export const extractJobsFromPages = defineCapability({
  type: 'market.extract_jobs_from_pages',
  version: 1,
  title: 'Extract Jobs from Pages',
  description: 'Deterministic JSON-LD JobPosting extraction with optional schema-validated AI fallback.',
  category: 'transform',
  inputSchema: z.object({
    sourceId: z.string(),
    pages: z.array(
      z.object({
        url: z.string(),
        artifact: artifactRefSchema.optional(),
        matched: z.boolean().default(false),
      }),
    ),
    /**
     * When the crawl started (the run trigger's `firedAt`) and the URL it started from (DECISION_LOG
     * 9b0cb03 L7): the crawl's evidence is at that time, on that URL's board. Stable across
     * retries, so a re-execution labels the same time and board. Omitted: now and the source's board.
     */
    startedAt: z.string().nullable().optional(),
    startUrl: z.string().nullable().optional(),
  }),
  outputSchema: z.object({
    records: recordSetSchema,
    count: z.number().int(),
    viaJsonLd: z.number().int(),
    viaAi: z.number().int(),
    skippedPages: z.number().int(),
    /**
     * When the crawl started, and the board it read (its start URL), both labelled here from the
     * run (re-verify #9 Low 6, #10 L7): ingest records its evidence at this time on this board,
     * never at its own processing time.
     */
    observedAt: z.string().optional(),
    board: copyBoardSchema.nullable().optional(),
  }),
  configSchema: z.object({
    useAiFallback: z.boolean().default(false),
    maxAiPages: z.number().int().min(0).max(50).default(10),
  }),
  // Not pure: it records the source's fetch outcome and health (L7).
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    defaultTimeoutMs: 10 * 60_000,
    idempotencyProof:
      "The extraction itself is a pure function of the stored page artifacts (records are content-addressed). Its writes are the source's fetch outcome, at the crawl's start time (stable across retries; never replacing a newer one: a retry that finds a newer fetch outcome changes no health), and health counters counted once per run.",
  },
  async execute(ctx, input, config) {
    const market = ctx.services.get(MARKET);
    const source = await market.sources.get(input.sourceId);
    const observedAt = input.startedAt ? new Date(input.startedAt) : ctx.clock.now();
    const board = boardOfSource(
      input.startUrl
        ? { provider: source.provider, endpoint: { ...source.endpoint, url: input.startUrl } }
        : source,
    );
    const out: Array<z.input<typeof listingItemSchema> & { payload: JobObservationPayload }> = [];
    let viaJsonLd = 0;
    let viaAi = 0;
    let skipped = 0;
    let aiBudget = config.useAiFallback ? config.maxAiPages : 0;
    const ai = ctx.services.has(AI_GATEWAY) ? ctx.services.get(AI_GATEWAY) : null;
    for (const page of input.pages) {
      if (!page.artifact) {
        skipped += 1;
        continue;
      }
      const html = await ctx.artifacts.readText(page.artifact);
      const postings = extractJsonLdJobPostings(html, page.url);
      if (postings.length) {
        postings.forEach((p, i) => out.push({ payload: p, locator: `${page.url}#jsonld/${i}` }));
        viaJsonLd += postings.length;
        continue;
      }
      if (page.matched && aiBudget > 0 && ai?.available) {
        aiBudget -= 1;
        const text = htmlToText(html).slice(0, 50_000);
        const res = await ai.structuredExtract({
          task: 'market.job_posting_extract',
          prompt: JOB_POSTING_EXTRACT_PROMPT,
          vars: { url: page.url, text },
          schema: jobPostingExtractSchema,
          schemaVersion: '1',
          inputRefs: [{ kind: 'artifact', id: page.artifact.artifactId }],
          signal: ctx.signal,
        });
        if (res.data.isJobPosting && res.data.title) {
          out.push({
            payload: {
              externalId: `url:${page.url}`,
              title: res.data.title,
              companyName: res.data.companyName ?? null,
              descriptionText: text,
              locations: res.data.locations.map((l) => ({ text: l })),
              employmentTypeText: res.data.employmentType ?? null,
              postingUrl: page.url,
              applyUrl: res.data.applyUrl ?? page.url,
              compensation: res.data.salaryText ? { text: res.data.salaryText } : null,
              provider: { name: 'careers_page', boardToken: null },
            },
            locator: `${page.url}#ai`,
            ai: {
              provider: res.meta.provider,
              model: res.meta.servedByModel,
              promptVersion: res.meta.promptVersion,
            },
          });
          viaAi += 1;
        }
      } else if (page.matched) {
        skipped += 1;
      }
    }
    ctx.log.info('extracted jobs from pages', { source: source.key, viaJsonLd, viaAi, skipped });
    await market.sources.recordAttempt(source._id, ctx.runId);
    const crawled = input.pages.some((p) => p.artifact);
    // Health follows the latest fetch: a re-execution of an older crawl (a newer fetch outcome is
    // recorded) changes neither the latest fetch nor the health (guarded on it, L-4).
    await market.sources.recordFetch(source._id, observedAt, crawled, ctx.runId);
    if (crawled)
      await market.sources.recordSuccess(source._id, {
        itemCount: out.length,
        runId: ctx.runId,
        fetchAt: observedAt,
      });
    else await market.sources.recordFailure(source._id, 'crawl fetched no pages', ctx.runId, observedAt);
    const records = await ctx.records.write(out.map((o) => listingItemSchema.parse(o)));
    return {
      records,
      count: out.length,
      viaJsonLd,
      viaAi,
      skippedPages: skipped,
      observedAt: observedAt.toISOString(),
      board,
    };
  },
});
