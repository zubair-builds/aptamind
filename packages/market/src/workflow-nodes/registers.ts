import { z } from 'zod';
import { artifactRefSchema } from '@aptamind/contracts';
import { HttpError } from '@aptamind/net';
import { defineCapability, recordSetSchema, RetryableError, TerminalError } from '@aptamind/workflow-sdk';
import { NET_CLIENT } from '@aptamind/workflow-nodes';
import { metrics } from '@aptamind/observability';
import { MARKET, type MarketDomain } from '../market-domain';
import {
  classifyRoute,
  keepEvidenceRows,
  type ParsedRegister,
  type RegisterAdapter,
  RegisterFormatError,
  registerAdapterById,
  registerAdapterForProvider,
  ROUTE_MEANINGS,
} from '../sources/providers/registers';
import {
  historyPeriodPlanSchema,
  historyShrinkReviewKey,
  type HistoryPeriodPlan,
  parserTag,
  planHistoryPeriods,
} from '../sources/providers/registers/history-periods';

/**
 * Register import capabilities (M8.4): the steps of `market.sponsor_register.import` shared by
 * every register adapter. The adapter is chosen by the source's `provider`; nothing here knows a
 * particular register. Finalisation (delisting, anomaly guard) is `market.finalize_dataset_import`,
 * the same step the UK import has always used.
 */

async function adapterOfSource(market: MarketDomain, sourceId: string) {
  const source = await market.sources.get(sourceId);
  const adapter = registerAdapterForProvider(source.provider);
  if (!adapter)
    throw new TerminalError(`Source ${source.key} has provider ${source.provider}, which is not a register`);
  return { source, adapter };
}

/** The URL a register source fetches without a run `url`: its endpoint, else the adapter default. */
export function registerEndpointOf(
  source: { endpoint: { url?: string | null } },
  adapter: Pick<RegisterAdapter, 'defaultEndpoint'>,
): string | null {
  return source.endpoint.url ?? adapter.defaultEndpoint;
}

/** Where the register's current file is: the run's `url`, the publication page's link, or the endpoint. */
export const locateRegisterDownload = defineCapability({
  type: 'market.locate_register_download',
  version: 1,
  title: 'Locate Register Download',
  description:
    'Resolves the URL of a sponsor register file for the source’s register adapter: an explicit url, the link on the publication page (registers whose file URL changes), the source endpoint, or the adapter’s default endpoint (NL: the labour register page). Skipped when reprocessing a snapshot.',
  category: 'acquisition',
  inputSchema: z.object({
    sourceId: z.string(),
    snapshotId: z.string().nullable().optional(),
    url: z.string().url().nullable().optional(),
  }),
  outputSchema: z.object({
    register: z.string(),
    url: z.string().nullable(),
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
    const { source, adapter } = await adapterOfSource(market, input.sourceId);
    const register = adapter.id;
    if (input.snapshotId) return { register, url: null, skipped: true, pageUrl: null };
    if (input.url) return { register, url: input.url, skipped: false, pageUrl: null };
    const endpoint = registerEndpointOf(source, adapter);
    if (!endpoint)
      throw new TerminalError(`Source ${source.key}: register ${register} needs endpoint.url or a run url`);
    if (!adapter.locateDownload) return { register, url: endpoint, skipped: false, pageUrl: null };
    try {
      // SSRF-safe egress: the platform's SafeHttpClient (NET_CLIENT), like every Market fetch.
      const res = await ctx.services.get(NET_CLIENT).getOk({ url: endpoint, signal: ctx.signal });
      const url = adapter.locateDownload(new TextDecoder().decode(res.body), res.url);
      if (!url) {
        await market.sources.recordFailure(source._id, 'register download link not found', ctx.runId);
        throw new TerminalError(`No register download link found on ${endpoint}`);
      }
      return { register, url, skipped: false, pageUrl: res.url };
    } catch (err) {
      if (err instanceof TerminalError) throw err;
      await market.sources.recordFailure(source._id, (err as Error).message, ctx.runId);
      if (err instanceof HttpError)
        throw err.retryable ? new RetryableError(err.message) : new TerminalError(err.message);
      throw err;
    }
  },
});

const routeCountSchema = z.object({
  route: z.string(),
  id: z.string().nullable(),
  meaning: z.enum(ROUTE_MEANINGS),
  rows: z.number().int(),
});

/**
 * Parse a register snapshot with its adapter and keep only the rows that are evidence. Rows on a
 * route the taxonomy marks `ignored` (study, au pair, exchange, unrecognised) never reach the
 * row step; the per-route counts say what was kept and what was dropped.
 */
export const parseRegisterSnapshot = defineCapability({
  type: 'market.parse_register_snapshot',
  version: 1,
  title: 'Parse Register Snapshot',
  description:
    'Parses a stored sponsor register file with the source’s register adapter (format detected from the content) into a JSONL record set of evidence rows; ignored routes are counted, not kept. History registers: per-fiscal-year shrink guard (changed in place in M11.5: optional input `snapshotId`, output `periods`; additive).',
  category: 'transform',
  inputSchema: z.object({
    sourceId: z.string(),
    artifact: artifactRefSchema,
    /** The snapshot being parsed (history registers: the per-period shrink guard, M11.5). */
    snapshotId: z.string().optional(),
  }),
  outputSchema: z.object({
    register: z.string(),
    format: z.string(),
    records: recordSetSchema,
    /** Evidence rows kept (the dataset size the anomaly guard compares). */
    count: z.number().int(),
    /** Every data row of the file. */
    totalRows: z.number().int(),
    skippedRows: z.number().int(),
    routes: z.array(routeCountSchema),
    /** Published routes the taxonomy does not list (their meaning is the adapter's default). */
    unlistedRoutes: z.array(z.string()),
    /**
     * History registers (M11.5): evidence rows per period (fiscal year); a held-back period (the
     * per-period shrink guard) is not processed and not counted in `count`.
     */
    periods: z.array(historyPeriodPlanSchema).optional(),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: false,
    idempotency: 'pure',
    sideEffects: false,
    defaultTimeoutMs: 10 * 60_000,
  },
  async execute(ctx, input) {
    const market = ctx.services.get(MARKET);
    const { adapter, source } = await adapterOfSource(market, input.sourceId);
    const bytes = await ctx.artifacts.readBytes(input.artifact);
    let parsed: ParsedRegister;
    try {
      parsed = adapter.parse(bytes);
    } catch (err) {
      if (err instanceof RegisterFormatError)
        throw new TerminalError(`${adapter.title}: unrecognised file (${err.message})`);
      throw new TerminalError(`${adapter.title}: file could not be read (${(err as Error).message})`);
    }
    const evidence = keepEvidenceRows(adapter, parsed.rows);
    const { routes } = evidence;
    let kept = evidence.kept;
    let periods: HistoryPeriodPlan[] | undefined;
    if (adapter.evidenceTier === 'history') {
      const snapshotId = input.snapshotId ?? '';
      const parser = parserTag(adapter.parser);
      periods = planHistoryPeriods(kept, source.health.historyPeriods, snapshotId, parser);
      // A held-back period an operator confirmed (the history source_anomaly, `confirm`, for this
      // snapshot, baseline and row count) is applied (delta review B-M2); a retry alone is not.
      const confirmed = new Map<number, number>();
      for (const p of periods.filter((x) => x.heldBack && x.marker)) {
        const item = await market.reviews.latestConfirmation(
          historyShrinkReviewKey(source._id, p.period, snapshotId, p.marker!),
          { kind: 'source', id: source._id },
        );
        const count = item?.context?.count;
        if (typeof count === 'number') confirmed.set(p.period, count);
      }
      if (confirmed.size)
        periods = planHistoryPeriods(kept, source.health.historyPeriods, snapshotId, parser, confirmed);
      const held = new Set(periods.filter((p) => p.heldBack).map((p) => p.period));
      if (held.size) {
        ctx.log.warn('history periods held back (shrink guard)', { periods: [...held] });
        kept = kept.filter((r) => !held.has(r.history?.fiscalYear ?? NaN));
      }
    }
    const records = await ctx.records.write(kept, { register: adapter.id });
    const unlistedRoutes = routes
      .filter((r) => r.id === null && adapter.routes.length > 0)
      .map((r) => r.route);
    if (unlistedRoutes.length)
      ctx.log.warn('register routes not in the taxonomy', { register: adapter.id, routes: unlistedRoutes });
    ctx.log.info('register parsed', { register: adapter.id, rows: parsed.rows.length, kept: kept.length });
    return {
      register: adapter.id,
      format: parsed.format,
      records,
      count: kept.length,
      totalRows: parsed.rows.length + parsed.skipped.length + (parsed.summedRows ?? 0),
      skippedRows: parsed.skipped.length,
      routes,
      unlistedRoutes,
      ...(periods ? { periods } : {}),
    };
  },
});

export const registerRowSchema = z.object({
  locator: z.string(),
  name: z.string(),
  route: z.string(),
  town: z.string().nullable().optional(),
  county: z.string().nullable().optional(),
  typeRating: z.string().nullable().optional(),
  identity: z.string().nullable().optional(),
  history: z
    .object({
      fiscalYear: z.number().int(),
      initialApprovals: z.number().int().min(0),
      initialDenials: z.number().int().min(0),
      continuingApprovals: z.number().int().min(0),
      continuingDenials: z.number().int().min(0),
      rowKey: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

/**
 * One register row → its adapter's company observation → resolution → reconciliation. The shared
 * rules hold for every adapter: a row on an ignored route is never evidence, a capability
 * listing is licence evidence for the register's own country only, and a history row (M11.5) is
 * history evidence that attaches to an existing company only (never creates one).
 */
export const processRegisterRow = defineCapability({
  type: 'market.process_register_row',
  version: 1,
  title: 'Process Register Row',
  description:
    'Maps a sponsor register row with its register adapter to company evidence for the register’s country: capability registers resolve (or create) the company with licence evidence; history registers attach history to an existing company only, or raise a review (never job sponsorship).',
  category: 'domain',
  inputSchema: z.object({
    sourceId: z.string(),
    snapshotId: z.string(),
    artifactId: z.string(),
    register: z.string(),
    row: registerRowSchema,
  }),
  outputSchema: z.object({
    outcome: z.string(),
    companyId: z.string().optional(),
    reviewItemId: z.string().optional(),
    observationId: z.string().optional(),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Observation id = hash(source, register record key, payload); resolution (attach-only for history) and reconciliation are deterministic and recompute from evidence; reviews are deduplicated by dedupeKey. Changed in place in M11.5 (PR B): input `row.history` added (additive; deploy together with M8.4).',
  },
  async execute(ctx, input) {
    const adapter = registerAdapterById(input.register);
    if (!adapter) throw new TerminalError(`Unknown register ${input.register}`);
    if (classifyRoute(adapter, input.row.route).meaning === 'ignored')
      return { outcome: 'skipped_ignored_route' };
    const mapped = adapter.toObservation(input.row);
    if (!mapped) return { outcome: 'skipped_invalid_row' };
    const { sponsorLicence: licence, sponsorshipHistory: history } = mapped.payload;
    // Tier and scope invariants: a capability register yields licence evidence only, a history
    // register history evidence only, each for the register's own country.
    const evidence = adapter.evidenceTier === 'capability' ? licence : history;
    const other = adapter.evidenceTier === 'capability' ? history : licence;
    if (!evidence || other || evidence.register !== adapter.id || evidence.country !== adapter.scope.country)
      throw new TerminalError(`Register ${adapter.id}: row mapped outside the register's tier or scope`);
    const record = {
      sourceId: input.sourceId,
      snapshotId: input.snapshotId,
      artifactId: input.artifactId,
      locator: input.row.locator,
      externalId: mapped.externalId,
      payload: mapped.payload,
      parser: adapter.parser,
      runId: ctx.runId,
    };
    const pipeline = ctx.services.get(MARKET).companyPipeline;
    // History registers never create companies: attach-only (M11.5).
    const r =
      adapter.evidenceTier === 'history'
        ? await pipeline.attachHistory(record, adapter.id)
        : await pipeline.process(record);
    metrics.inc('market_register_rows_total', {
      register: adapter.id,
      outcome: r.outcome === 'unmatched' ? `skipped_${r.reason}` : r.outcome,
    });
    // An unmatched history row leaves no observation; its reason is the counted row outcome.
    if (r.outcome === 'unmatched') return { outcome: `skipped_${r.reason}` };
    return {
      outcome: r.outcome,
      observationId: r.observationId,
      companyId: 'companyId' in r ? r.companyId : undefined,
      reviewItemId: 'reviewItemId' in r ? r.reviewItemId : undefined,
    };
  },
});
