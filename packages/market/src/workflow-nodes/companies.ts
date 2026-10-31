import { z } from 'zod';
import { jsonObjectSchema, SYSTEM_ACTOR } from '@aptamind/contracts';
import { HttpError, type SafeHttpClient } from '@aptamind/net';
import { type CapabilityContext, defineCapability, TerminalError } from '@aptamind/workflow-sdk';
import { NET_CLIENT } from '@aptamind/workflow-nodes';
import { ATS_PROVIDERS, type AtsProvider } from '../contracts/common';
import { companyObservationPayloadSchema } from '../contracts/observations';
import { getAdapter, regionOfApiBase } from '../connectors';
import { AtsDetectionSet, candidateCareersPaths, detectAts, findCareersLinks } from '../discovery';
import { MARKET, type MarketDomain } from '../market-domain';
import type { CompanyDoc } from '../companies/company.schema';
import {
  atsBoardIdentity,
  type BoardIdentity,
  raiseBoardOwnerReview,
  registerAtsBoard,
} from '../sources/board-registration';
import type { SourceDoc } from '../sources/source.schema';
import { REVIEW_ACTIONS, REVIEW_TYPES } from '../review/schemas';
import {
  historyPeriodPlanSchema,
  historyShrinkReviewKey,
  parserTag,
  type RegisterAdapter,
  registerAdapterForProvider,
} from '../sources/providers/registers';
import { sponsorRowToPayload, UK_SPONSOR_PARSER } from '../sources/providers/uk-sponsor-register';
import { classifyRoute, ukSponsorRegisterAdapter } from '../sources/providers/registers';

const processOutcome = z.object({
  outcome: z.string(),
  observationId: z.string(),
  companyId: z.string().optional(),
  reviewItemId: z.string().optional(),
});

/** Create Company Observation: record what a source said (idempotent). */
export const createCompanyObservation = defineCapability({
  type: 'market.create_company_observation',
  version: 1,
  title: 'Create Company Observation',
  description: 'Records an immutable company observation (idempotent on source + record + content).',
  category: 'domain',
  inputSchema: z.object({
    sourceId: z.string(),
    snapshotId: z.string().optional(),
    artifactId: z.string().optional(),
    locator: z.string().optional(),
    externalId: z.string().optional(),
    payload: companyObservationPayloadSchema,
    parser: z.object({ name: z.string(), version: z.string() }).default({ name: 'workflow', version: '1' }),
  }),
  outputSchema: z.object({ observationId: z.string(), created: z.boolean(), resolutionState: z.string() }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Observation id = hash(source, record, payload); insert-or-touch; seenCount counts distinct runs.',
  },
  async execute(ctx, input) {
    const { observation, created } = await ctx.services
      .get(MARKET)
      .observations.recordCompanyObservation({ ...input, runId: ctx.runId });
    return { observationId: observation._id, created, resolutionState: observation.resolution.state };
  },
});

/** Resolve Company: match an observation to a canonical company, create one, or raise review. */
export const resolveCompany = defineCapability({
  type: 'market.resolve_company',
  version: 1,
  title: 'Resolve Company',
  description:
    'Deterministic entity resolution of a company observation (id → domain → legal name → aliases → review).',
  category: 'domain',
  inputSchema: z.object({ observationId: z.string() }),
  outputSchema: processOutcome,
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Deterministic resolution over unique identityKeys (a lost creation race re-resolves to the winner); review items are deduplicated by dedupeKey.',
  },
  async execute(ctx, input) {
    const market = ctx.services.get(MARKET);
    const o = await market.observations.companyObservations.findOne({ _id: input.observationId });
    if (!o) throw new TerminalError(`Observation ${input.observationId} not found`);
    if (o.resolution.state === 'resolved' && o.resolution.entityId) {
      return { outcome: 'already_resolved', observationId: o._id, companyId: o.resolution.entityId };
    }
    const r = await market.companyPipeline.resolveObservation(o);
    return r.outcome === 'review'
      ? { outcome: 'review', observationId: o._id, reviewItemId: r.reviewItemId }
      : { outcome: r.outcome, observationId: o._id, companyId: r.companyId };
  },
});

/** Reconcile Company: recompute canonical facts from all resolved observations. */
export const reconcileCompany = defineCapability({
  type: 'market.reconcile_company',
  version: 1,
  title: 'Reconcile / Publish Company',
  description: 'Recomputes canonical company facts with provenance, confidence and conflicts.',
  category: 'domain',
  inputSchema: z.object({ companyId: z.string() }),
  outputSchema: z.object({
    companyId: z.string(),
    changed: z.boolean(),
    conflictFields: z.array(z.string()),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Recomputes canonical facts from all resolved observations; the same evidence yields the same document.',
  },
  async execute(ctx, input) {
    const { company, changed } = await ctx.services.get(MARKET).companyReconciler.reconcile(input.companyId);
    return { companyId: company._id, changed, conflictFields: company.quality.conflictFields };
  },
});

/** Composite step used for large fan-outs: observation → resolution → reconciliation. */
export const processCompanyObservation = defineCapability({
  type: 'market.process_company_observation',
  version: 1,
  title: 'Process Company Candidate',
  description:
    'Records, resolves and reconciles one company candidate using the domain services (idempotent).',
  category: 'domain',
  inputSchema: z.object({
    sourceId: z.string(),
    snapshotId: z.string().optional(),
    artifactId: z.string().optional(),
    locator: z.string().optional(),
    externalId: z.string().optional(),
    payload: companyObservationPayloadSchema,
  }),
  outputSchema: processOutcome,
  configSchema: z.object({ parser: z.string().default('workflow'), parserVersion: z.string().default('1') }),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Composition of observation recording (hash id), resolution (unique identity keys, deduplicated reviews) and reconciliation (recompute).',
  },
  async execute(ctx, input, config) {
    const r = await ctx.services.get(MARKET).companyPipeline.process({
      ...input,
      parser: { name: config.parser, version: config.parserVersion },
      runId: ctx.runId,
    });
    return {
      outcome: r.outcome,
      observationId: r.observationId,
      companyId: 'companyId' in r ? r.companyId : undefined,
      reviewItemId: 'reviewItemId' in r ? r.reviewItemId : undefined,
    };
  },
});

/** UK sponsor register row → company capability evidence → resolution → reconciliation. */
export const processSponsorRow = defineCapability({
  type: 'market.process_sponsor_row',
  version: 1,
  title: 'Process Sponsor Register Row',
  description:
    'Maps a register row to a company candidate with licence evidence and processes it (company capability, never job sponsorship).',
  category: 'domain',
  inputSchema: z.object({
    sourceId: z.string(),
    snapshotId: z.string(),
    artifactId: z.string(),
    rowIndex: z.number().int(),
    row: z.object({
      name: z.string().nullable().optional(),
      town: z.string().nullable().optional(),
      county: z.string().nullable().optional(),
      typeRating: z.string().nullable().optional(),
      route: z.string().nullable().optional(),
    }),
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
      'Observation id = hash(source, row, payload); resolution and reconciliation are deterministic and recompute from evidence.',
  },
  async execute(ctx, input) {
    // M8.4b: a route the UK taxonomy ignores is not evidence (same rule as the generic import).
    if (input.row.route && classifyRoute(ukSponsorRegisterAdapter, input.row.route).meaning === 'ignored')
      return { outcome: 'skipped_ignored_route' };
    const mapped = sponsorRowToPayload(input.row);
    if (!mapped) return { outcome: 'skipped_invalid_row' };
    const r = await ctx.services.get(MARKET).companyPipeline.process({
      sourceId: input.sourceId,
      snapshotId: input.snapshotId,
      artifactId: input.artifactId,
      locator: `row:${input.rowIndex + 2}`,
      externalId: mapped.externalId,
      payload: mapped.payload,
      parser: UK_SPONSOR_PARSER,
      runId: ctx.runId,
    });
    return {
      outcome: r.outcome,
      observationId: r.observationId,
      companyId: 'companyId' in r ? r.companyId : undefined,
      reviewItemId: 'reviewItemId' in r ? r.reviewItemId : undefined,
    };
  },
});

/**
 * Finalise a full dataset import. Only a healthy, complete import advances the source's
 * "last complete import" marker — which is what makes companies absent from the dataset
 * `no_longer_listed`. A suspiciously small dataset or a high failure ratio holds back that
 * destructive effect and raises a `source_anomaly` review instead.
 */
const finalizeInputSchema = z.object({
  sourceId: z.string(),
  snapshotId: z.string(),
  importStartedAt: z.string(),
  /** Source chronology of the imported snapshot: the complete-import marker. */
  snapshotFetchedAt: z.string().nullable().optional(),
  rowCount: z.number().int(),
  fanout: z.object({ total: z.number().int(), succeeded: z.number().int(), failed: z.number().int() }),
  /**
   * History registers (M11.5): the parse step's period decisions, applied as is (delta review
   * B-M1). Changed in place: additive, absent for every other dataset.
   */
  periods: z.array(historyPeriodPlanSchema).nullable().optional(),
});
const finalizeOutputSchema = z.object({
  complete: z.boolean(),
  anomaly: z.string().nullable(),
  delistedCompanies: z.number().int(),
  reconciled: z.number().int(),
});
const finalizeConfigSchema = z.object({
  minRowRatio: z.number().min(0).max(1).default(0.5),
  maxFailureRatio: z.number().min(0).max(1).default(0.05),
});

export const finalizeDatasetImport = defineCapability({
  type: 'market.finalize_dataset_import',
  version: 1,
  title: 'Finalize Dataset Import',
  description:
    'Marks a complete import, reconciles delisted companies, and guards against anomalous datasets.',
  category: 'domain',
  inputSchema: finalizeInputSchema,
  outputSchema: finalizeOutputSchema,
  configSchema: finalizeConfigSchema,
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    defaultTimeoutMs: 30 * 60_000,
    idempotencyProof:
      'Licence status is recomputed from the latest complete import marker (set-based, $max); anomaly reviews are deduplicated; replays recompute the same state. History registers: period markers move by compare-and-set on the marker the parse step read. Changed in place in M11.5: optional input `periods` (additive; history registers only).',
  },
  async execute(ctx, input, config) {
    const market = ctx.services.get(MARKET);
    const source = await market.sources.get(input.sourceId);
    const previous = source.health.lastItemCount;
    const failureRatio = input.fanout.total ? input.fanout.failed / input.fanout.total : 0;
    // A history register (M11.5) replaces rows per fiscal year: its shrink guard is per period
    // (`finalizeHistoryImport`), never the dataset-wide one.
    const adapter = registerAdapterForProvider(source.provider);
    if (adapter?.evidenceTier === 'history')
      return finalizeHistoryImport(ctx, input, config, source, adapter, failureRatio);
    let anomaly: string | null = null;
    if (previous && input.rowCount < previous * config.minRowRatio)
      anomaly = `dataset shrank from ${previous} to ${input.rowCount} rows`;
    else if (failureRatio > config.maxFailureRatio)
      anomaly = `${input.fanout.failed}/${input.fanout.total} rows failed processing`;
    if (anomaly) {
      await market.reviews.raise({
        type: 'source_anomaly',
        severity: 'high',
        dedupeKey: `source_anomaly:${source._id}:${input.snapshotId}`,
        entity: { kind: 'source', id: source._id },
        subject: `${source.name}: import held back (${anomaly})`,
        reason: `${anomaly}. Delisting was not applied; confirm the dataset or retry.`,
        evidence: [{ sourceId: source._id, snapshotId: input.snapshotId, observedAt: ctx.clock.now() }],
        context: {
          sourceId: source._id,
          snapshotId: input.snapshotId,
          retryInput: { snapshotId: input.snapshotId },
        },
        allowedActions: ['retry', 'confirm', 'dismiss'],
      });
      await market.sources.recordFailure(source._id, `import anomaly: ${anomaly}`, ctx.runId);
      return { complete: false, anomaly, delistedCompanies: 0, reconciled: 0 };
    }
    // The complete-import marker is the imported snapshot's SOURCE time (never the processing
    // time): reprocessing an older register snapshot cannot move it forward and delist licences
    // that a newer snapshot lists. It only moves forward ($max).
    const startedAt = input.snapshotFetchedAt
      ? new Date(input.snapshotFetchedAt)
      : (await market.observations.getSnapshot(input.snapshotId)).lastFetchedAt;
    await market.sources.recordSuccess(source._id, {
      snapshotId: input.snapshotId,
      itemCount: input.rowCount,
      completeImportStartedAt: startedAt,
      runId: ctx.runId,
    });
    await market.observations.setSnapshotItemCount(input.snapshotId, input.rowCount);
    // Companies whose licence observations were not seen in this complete import.
    const stale = await market.observations.companyObservations
      .aggregate<{ _id: string }>([
        {
          $match: {
            sourceId: source._id,
            'resolution.state': 'resolved',
            $expr: { $lt: [{ $ifNull: ['$sourceObservedAt', '$lastObservedAt'] }, startedAt] },
          },
        },
        { $group: { _id: '$resolution.entityId' } },
      ])
      .toArray();
    let reconciled = 0;
    for (const s of stale) {
      await market.companyReconciler.reconcile(s._id);
      reconciled += 1;
      if (reconciled % 50 === 0) await ctx.heartbeat();
    }
    ctx.log.info('dataset import finalised', { rows: input.rowCount, delisted: stale.length });
    return { complete: true, anomaly: null, delistedCompanies: stale.length, reconciled };
  },
});

/**
 * Wave 7 (MKT-OPS source DoD 3): an unchanged register file stops downstream processing. The
 * import takes the `unchanged` path only when ALL hold: the run fetched (not a reprocessing of a
 * stored snapshot, which an operator asks for on purpose), the bytes equal the source's previous
 * snapshot, and that same snapshot is the one the source's last COMPLETE import applied
 * (`health.lastSnapshotId`, written only by a clean finalisation). A held-back (anomalous) or
 * failed import never wrote it, so its file is processed in full again.
 *
 * The unchanged path writes no observation and never moves the delisting marker
 * (`lastCompleteImportStartedAt`): rows of an unprocessed run must not count as "not seen".
 * It records the run as a healthy success with the last item count; the snapshot's own
 * `lastFetchedAt` (moved by the fetch) is the evidence that the register still published it.
 */
export const checkDatasetUnchanged = defineCapability({
  type: 'market.check_dataset_unchanged',
  version: 1,
  title: 'Check Dataset Unchanged',
  description:
    'Routes a dataset import: an unchanged file whose snapshot was already applied by a complete import ends the run; anything else is imported in full.',
  category: 'domain',
  inputSchema: z.object({
    sourceId: z.string(),
    snapshotId: z.string(),
    unchanged: z.boolean(),
    reprocessing: z.boolean(),
  }),
  outputSchema: z.object({
    path: z.enum(['unchanged', 'import']),
    itemCount: z.number().int().nullable(),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'A pure decision on the source health and the fetch output; the only write is a health success counted once per run (countOnce on the run id).',
  },
  async execute(ctx, input) {
    const market = ctx.services.get(MARKET);
    const source = await market.sources.get(input.sourceId);
    const applied =
      source.health.lastSnapshotId === input.snapshotId && source.health.lastItemCount !== undefined;
    if (input.reprocessing || !input.unchanged || !applied)
      return { path: 'import' as const, itemCount: null };
    await market.sources.recordSuccess(source._id, { runId: ctx.runId });
    ctx.log.info('dataset unchanged; import skipped', {
      source: source.key,
      snapshotId: input.snapshotId,
      rows: source.health.lastItemCount,
    });
    return { path: 'unchanged' as const, itemCount: source.health.lastItemCount ?? null };
  },
});

type FinalizeInput = z.infer<typeof finalizeInputSchema>;
type FinalizeConfig = z.infer<typeof finalizeConfigSchema>;

/**
 * Finalise a history-register import (M11.5, DECISION_LOG "Sponsor register adapters" (3)): per
 * period (fiscal year) of the snapshot, a complete import moves the period's marker to the
 * snapshot's source time, which replaces the source's earlier rows of that period (the companies
 * holding them are re-reconciled). A period whose rows shrank below half of its last complete
 * import was held back by the parse step (same computation) and moves nothing; a failure ratio
 * above the limit moves no period. Either raises a `source_anomaly` review.
 */
async function finalizeHistoryImport(
  ctx: CapabilityContext,
  input: FinalizeInput,
  config: FinalizeConfig,
  source: SourceDoc,
  adapter: RegisterAdapter,
  failureRatio: number,
): Promise<z.infer<typeof finalizeOutputSchema>> {
  const market = ctx.services.get(MARKET);
  if (!input.periods)
    throw new TerminalError(`${source.key}: a history import is finalised with the parse step's periods`);
  const snapshot = await market.observations.getSnapshot(input.snapshotId);
  const completeAt = input.snapshotFetchedAt ? new Date(input.snapshotFetchedAt) : snapshot.lastFetchedAt;
  const parser = parserTag(adapter.parser);
  const failed = failureRatio > config.maxFailureRatio;
  const problems: string[] = [];
  if (failed) problems.push(`${input.fanout.failed}/${input.fanout.total} rows failed processing`);
  const applied: number[] = [];
  for (const p of input.periods) {
    if (p.heldBack) {
      // One review per held period, keyed to its baseline: `confirm` accepts exactly this shrink
      // (the next run of this snapshot applies it); `retry` alone keeps it held (B-M2).
      await market.reviews.raise({
        type: 'source_anomaly',
        severity: 'high',
        dedupeKey: historyShrinkReviewKey(source._id, p.period, input.snapshotId, p.marker!),
        entity: { kind: 'source', id: source._id },
        subject: `${source.name}: FY${p.period} held back (shrank from ${p.previousRows} to ${p.rows} rows)`,
        reason: `FY${p.period} of this file has ${p.rows} rows, under half of the ${p.previousRows} of its last complete import; its previous rows are kept. Confirm to accept this file for FY${p.period} (then re-run the snapshot), or dismiss.`,
        evidence: [{ sourceId: source._id, snapshotId: input.snapshotId, observedAt: ctx.clock.now() }],
        context: {
          sourceId: source._id,
          snapshotId: input.snapshotId,
          period: p.period,
          count: p.rows,
          previousRows: p.previousRows,
          retryInput: { snapshotId: input.snapshotId },
        },
        allowedActions: ['confirm', 'retry', 'dismiss'],
      });
      problems.push(`FY${p.period} shrank from ${p.previousRows} to ${p.rows} rows`);
      continue;
    }
    if (failed) continue;
    const outcome = await market.sources.casHistoryPeriod(
      source._id,
      { period: p.period, completeAt, rowCount: p.rows, snapshotId: input.snapshotId, parser },
      p.marker ? { snapshotId: p.marker.snapshotId, completeAt: new Date(p.marker.completeAt) } : null,
    );
    if (outcome === 'applied') applied.push(p.period);
    else if (outcome === 'moved')
      problems.push(
        `FY${p.period} marker moved during the import (another import of the year finished first)`,
      );
  }
  // Companies holding this source's rows of an applied period that this import replaced.
  const replaced = applied.length
    ? await market.observations.companyObservations
        .aggregate<{ _id: string }>([
          {
            $match: {
              sourceId: source._id,
              'resolution.state': 'resolved',
              'payload.sponsorshipHistory.fiscalYear': { $in: applied },
              $expr: { $lt: [{ $ifNull: ['$sourceObservedAt', '$lastObservedAt'] }, completeAt] },
            },
          },
          { $group: { _id: '$resolution.entityId' } },
        ])
        .toArray()
    : [];
  let reconciled = 0;
  for (const r of replaced) {
    await market.companyReconciler.reconcile(r._id);
    reconciled += 1;
    if (reconciled % 50 === 0) await ctx.heartbeat();
  }
  const snapshotProblems = problems.filter((x) => !/shrank/.test(x));
  if (snapshotProblems.length)
    await market.reviews.raise({
      type: 'source_anomaly',
      severity: 'high',
      dedupeKey: `source_anomaly:${source._id}:${input.snapshotId}`,
      entity: { kind: 'source', id: source._id },
      subject: `${source.name}: import held back (${snapshotProblems.join('; ')})`,
      reason: `${snapshotProblems.join('; ')}. The affected fiscal years kept their previous rows (rows this run processed count beside them until the next complete import of the year); re-run the import.`,
      evidence: [{ sourceId: source._id, snapshotId: input.snapshotId, observedAt: ctx.clock.now() }],
      context: {
        sourceId: source._id,
        snapshotId: input.snapshotId,
        retryInput: { snapshotId: input.snapshotId },
      },
      allowedActions: ['retry', 'confirm', 'dismiss'],
    });
  if (problems.length) {
    const anomaly = problems.join('; ');
    await market.sources.recordFailure(source._id, `import anomaly: ${anomaly}`, ctx.runId);
    return { complete: false, anomaly, delistedCompanies: 0, reconciled };
  }
  await market.sources.recordSuccess(source._id, {
    snapshotId: input.snapshotId,
    itemCount: input.rowCount,
    completeImportStartedAt: completeAt,
    runId: ctx.runId,
  });
  await market.observations.setSnapshotItemCount(input.snapshotId, input.rowCount);
  ctx.log.info('history import finalised', { rows: input.rowCount, periods: applied });
  return { complete: true, anomaly: null, delistedCompanies: 0, reconciled };
}

async function fetchHtml(
  http: SafeHttpClient,
  url: string,
  scopeHosts: string[],
  signal: AbortSignal,
): Promise<{ url: string; html: string } | null> {
  try {
    const res = await http.request({
      url,
      timeoutMs: 20_000,
      maxBytes: 5 * 1024 * 1024,
      scope: { allowedHosts: scopeHosts, allowSubdomains: true },
      signal,
    });
    if (!res.ok || !/html/.test(res.contentType)) return null;
    return { url: res.url, html: new TextDecoder().decode(res.body) };
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
}

/**
 * Discover Careers + Detect ATS for a company (WF2). Bounded: homepage + at most 6 careers
 * candidates, host-scoped to the company's official domain (ATS hosts are detected from
 * links, never crawled). Results are recorded as an observation from the discovery source.
 */
const discoverCareersSpec = {
  type: 'market.discover_careers',
  title: 'Discover Careers & Detect ATS',
  description:
    'Finds the careers page and ATS board for a company from its official website.' +
    ' Changed in place in PR #11 (accepted exception, see streams/market.md): ' +
    'detections carry the regional apiBase (M6.3, additive output).',
  category: 'domain',
  inputSchema: z.object({ companyId: z.string() }),
  outputSchema: z.object({
    companyId: z.string(),
    status: z.enum(['found', 'not_found', 'failed', 'website_unknown']),
    careersUrl: z.string().nullable(),
    ats: z.array(
      z.object({
        provider: z.enum(ATS_PROVIDERS),
        boardToken: z.string(),
        /** Provider API base of the board's region (M6.3); `register_job_source` registers on it. */
        apiBase: z.string(),
        confidence: z.string(),
        evidence: z.string(),
      }),
    ),
    pagesFetched: z.number().int(),
  }),
  configSchema: z.object({ maxCandidates: z.number().int().min(1).max(10).default(6) }),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    queue: 'io',
    defaultTimeoutMs: 5 * 60_000,
    idempotencyProof:
      'Discovery observation id = hash(source, company, payload); company reconciliation recomputes; ATS source registration is idempotent on provider:token.',
  },
} as const;

type DiscoverInput = z.infer<typeof discoverCareersSpec.inputSchema>;
type DiscoverConfig = z.infer<typeof discoverCareersSpec.configSchema>;
type DiscoverOutput = z.infer<typeof discoverCareersSpec.outputSchema>;

async function runCareersDiscovery(
  ctx: CapabilityContext,
  input: DiscoverInput,
  config: DiscoverConfig,
): Promise<DiscoverOutput> {
  const market = ctx.services.get(MARKET);
  const company = await market.companies.resolveActive(input.companyId);
  const now = ctx.clock.now();
  const domain = company.identity.domain.value;
  const setStatus = (status: 'found' | 'not_found' | 'failed' | 'website_unknown') =>
    market.companies.col.updateOne(
      { _id: company._id },
      { $set: { 'freshness.careersDiscoveryStatus': status, 'freshness.careersCheckedAt': now } },
    );
  if (!domain) {
    await setStatus('website_unknown');
    return {
      companyId: company._id,
      status: 'website_unknown' as const,
      careersUrl: null,
      ats: [],
      pagesFetched: 0,
    };
  }
  const http = ctx.services.get(NET_CLIENT);
  const home = company.identity.website.value ?? `https://${domain}/`;
  // Crawl scope: the official domain plus the official website's host (same company).
  const scopeHosts = [...new Set([domain, new URL(home).hostname])];
  const visited = new Set<string>();
  // Across pages: by provider, region and token, strongest evidence wins; a region-less guess
  // yields to an explicit (regional) URL of the same board (A-L3).
  const detections = new AtsDetectionSet();
  let careersUrl: string | null = null;
  let pages = 0;
  const visit = async (url: string) => {
    if (visited.has(url) || visited.size >= config.maxCandidates + 1) return null;
    visited.add(url);
    const page = await fetchHtml(http, url, scopeHosts, ctx.signal);
    if (!page) return null;
    pages += 1;
    for (const d of detectAts(page.html, page.url)) detections.add(d);
    return page;
  };
  const homePage = await visit(home);
  const linkCandidates = homePage ? findCareersLinks(homePage.html, homePage.url) : [];
  for (const l of linkCandidates.slice(0, 3)) {
    const atsHit = detections.list().some((d) => l.url.includes(d.boardToken));
    if (atsHit) continue;
    const p = await visit(l.url);
    if (p && !careersUrl) careersUrl = p.url;
  }
  if (!careersUrl && !detections.list().length) {
    const origin = new URL(home).origin;
    const originPaths = ['/careers', '/jobs', '/join-us'].map((p) => `${origin}${p}`);
    for (const path of [...new Set([...originPaths, ...candidateCareersPaths(domain)])]) {
      const p = await visit(path);
      if (p) {
        careersUrl = p.url;
        break;
      }
    }
  }
  if (!careersUrl && linkCandidates[0]) careersUrl = linkCandidates[0].url;
  const ats = detections.list();
  const status: 'found' | 'not_found' | 'failed' =
    careersUrl || ats.length ? 'found' : pages === 0 ? 'failed' : 'not_found';
  const discoverySource = await market.sources.getByKey('system:careers-discovery');
  if (discoverySource && (careersUrl || ats.length)) {
    const best = ats.find((a) => a.confidence === 'high') ?? ats[0];
    const { observation } = await market.observations.recordCompanyObservation({
      sourceId: discoverySource._id,
      externalId: `careers:${company._id}`,
      locator: careersUrl ?? home,
      payload: {
        name: company.identity.displayName.value ?? company.identity.normalizedName,
        aliases: [],
        externalIds: [],
        locations: [],
        industries: [],
        careersUrl,
        ats: best
          ? {
              provider: best.provider,
              boardToken: best.boardToken,
              region: regionOfApiBase(getAdapter(best.provider), best.apiBase) ?? 'unknown',
              apiBase: best.apiBase,
            }
          : null,
      },
      parser: { name: 'careers-discovery', version: '1' },
      runId: ctx.runId,
    });
    await market.observations.setCompanyResolution([observation._id], {
      state: 'resolved',
      entityId: company._id,
      method: 'discovery',
      confidence: 'high',
      resolverVersion: 'discovery',
    });
    await market.companyReconciler.reconcile(company._id);
  }
  if (ats.length > 1 && !ats.every((a) => a.provider === ats[0]?.provider)) {
    await market.reviews.raise({
      type: 'careers_discovery',
      severity: 'low',
      dedupeKey: `careers_discovery:${company._id}:multiple_ats`,
      entity: { kind: 'company', id: company._id },
      subject: `${company.identity.displayName.value}: several ATS boards detected`,
      reason: ats.map((a) => `${a.provider}:${a.boardToken} (${a.confidence})`).join(', '),
      context: { ats: ats.map((a) => ({ provider: a.provider, boardToken: a.boardToken })) },
      allowedActions: ['confirm', 'dismiss'],
    });
  }
  await setStatus(status);
  return {
    companyId: company._id,
    status,
    careersUrl,
    ats: ats.map((a) => ({ ...a })),
    pagesFetched: pages,
  };
}

/** v1 (runs pinned before OPS-1): a discovery that throws records no attempt. */
export const discoverCareersV1 = defineCapability({
  ...discoverCareersSpec,
  version: 1,
  execute: runCareersDiscovery,
});

/**
 * v2 (OPS-1): a discovery that throws records the attempt as `failed`, so the hourly batch
 * moves on to other companies instead of picking the same one every hour.
 */
export const discoverCareers = defineCapability({
  ...discoverCareersSpec,
  version: 2,
  async execute(ctx, input, config) {
    try {
      return await runCareersDiscovery(ctx, input, config);
    } catch (err) {
      const market = ctx.services.get(MARKET);
      await market.companies.col
        .updateOne(
          { _id: input.companyId },
          {
            $set: {
              'freshness.careersDiscoveryStatus': 'failed',
              'freshness.careersCheckedAt': ctx.clock.now(),
            },
          },
        )
        // The discovery error is the one to report; a failed write here is only logged.
        .catch((writeErr: unknown) =>
          ctx.log.warn('could not record the failed discovery attempt', { error: String(writeErr) }),
        );
      throw err;
    }
  },
});

/** Create/Register Job Source for a detected ATS board or careers page (idempotent on key). */
type RegisterJobSourceConfig = { refreshIntervalMinutes: number; enableSchedule: boolean };
type RegisterJobSourceResult = { sourceId: string; key: string; created: boolean };

async function registerCareersPage(
  ctx: { runId: string },
  market: MarketDomain,
  company: CompanyDoc,
  url: string | null | undefined,
  config: RegisterJobSourceConfig,
): Promise<RegisterJobSourceResult> {
  if (!url) throw new TerminalError('url is required for careers_page sources');
  const name = company.identity.displayName.value ?? company.identity.normalizedName;
  const host = new URL(url).hostname.replace(/^www\./, '');
  const { source, created } = await market.sources.register(
    {
      key: `careers_page:${host}${new URL(url).pathname.replace(/\/$/, '')}`,
      name: `${name} careers page`,
      category: 'job_source',
      provider: 'careers_page',
      endpoint: { url },
      acquisition: { workflowKey: 'market.careers_page.crawl', config: { startUrl: url } },
      companyId: company._id,
      schedule: config.enableSchedule ? { intervalMinutes: 24 * 60, timezone: 'UTC' } : undefined,
      freshness: { policyClass: 'source.careers_page', maxAgeMinutes: 3 * 24 * 60 },
      authority: { tier: 'official_site', authoritativeFor: ['job content'], listingIsComplete: false },
      governance: { accessMethod: 'public_web', crawlPolicy: 'host-scoped, ≤25 pages, depth ≤2' },
    },
    { kind: 'workflow', id: ctx.runId },
  );
  return { sourceId: source._id, key: source.key, created };
}

/**
 * Before M6.3 a regional board was registered on the default key and host, where it does not
 * exist. Flag such a legacy source of the same company instead of silently keeping both.
 */
async function raiseRegionalLegacyReview(
  market: MarketDomain,
  company: CompanyDoc,
  provider: AtsProvider,
  boardToken: string,
  source: SourceDoc,
  identity: BoardIdentity,
  ignoreCase = false,
): Promise<void> {
  const legacyKey = `${provider}:${ignoreCase ? boardToken.toLowerCase() : boardToken}`;
  const legacy = ignoreCase
    ? await market.sources.getByKeyIgnoringCase(legacyKey)
    : await market.sources.getByKey(legacyKey);
  if (!legacy || legacy.companyId !== company._id || !legacy.enabled) return;
  const name = company.identity.displayName.value ?? company.identity.normalizedName;
  await market.reviews.raise({
    type: 'careers_discovery',
    severity: 'low',
    dedupeKey: `careers_discovery:regional:${legacy._id}:${source._id}`,
    entity: { kind: 'company', id: company._id },
    subject: `${name}: ${provider} board ${boardToken} is ${identity.region.toUpperCase()}-hosted but also registered on the default host`,
    reason: `Source ${legacy.key} targets ${legacy.endpoint.url ?? 'the default host'}; the board was detected on ${identity.apiBase}. Disable ${legacy.key} if it only fails or returns another board.`,
    context: { sourceId: legacy._id, legacySourceId: legacy._id, regionalSourceId: source._id },
    allowedActions: ['confirm', 'dismiss'],
  });
}

export const registerJobSourceV1 = defineCapability({
  type: 'market.register_job_source',
  version: 1,
  title: 'Register Job Source',
  description:
    'Registers a discovered ATS board or careers page as a scheduled job source linked to its company.' +
    ' Changed in place in PR #11 (accepted exception, see streams/market.md): ' +
    'optional apiBase input; regional boards get a provider:region:token key (M6.3).',
  category: 'domain',
  inputSchema: z.object({
    companyId: z.string(),
    provider: z.enum([...ATS_PROVIDERS, 'careers_page']),
    boardToken: z.string().nullable().optional(),
    /**
     * ATS: the provider API base of the board's region, as detected (M6.3). Must be one of the
     * adapter's known bases; omitted/null = the default host (the behaviour before M6.3).
     */
    apiBase: z.string().url().nullable().optional(),
    url: z.string().url().nullable().optional(),
  }),
  outputSchema: z.object({ sourceId: z.string(), key: z.string(), created: z.boolean() }),
  configSchema: z.object({
    refreshIntervalMinutes: z.number().int().positive().default(360),
    enableSchedule: z.boolean().default(true),
  }),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Source registration is idempotent on its key (provider:boardToken, or provider:region:boardToken for a regional host; unique index); a repeat returns the existing source; reviews are raised on deterministic dedupe keys.',
  },
  async execute(ctx, input, config) {
    const market = ctx.services.get(MARKET);
    const company = await market.companies.resolveActive(input.companyId);
    if (input.provider === 'careers_page')
      return registerCareersPage(ctx, market, company, input.url, config);
    const provider = input.provider as AtsProvider;
    if (!input.boardToken) throw new TerminalError('boardToken is required for ATS sources');
    // Only a known API base of this provider may become an endpoint (never a host taken from
    // page content); the region is part of the key because board tokens are per data centre.
    let identity: BoardIdentity;
    try {
      identity = atsBoardIdentity(provider, input.boardToken, input.apiBase);
    } catch (err) {
      throw new TerminalError((err as Error).message);
    }
    const { region } = identity;
    const { source, created } = await registerAtsBoard(
      market.sources,
      {
        company,
        provider,
        boardToken: input.boardToken,
        identity,
        refreshIntervalMinutes: config.refreshIntervalMinutes,
        enableSchedule: config.enableSchedule,
      },
      { kind: 'workflow', id: ctx.runId },
    );
    const regional = region !== 'default';
    if (!created && source.companyId && source.companyId !== company._id)
      // Two companies claim the same board: surface it rather than silently re-linking.
      await raiseBoardOwnerReview(
        market.reviews,
        source,
        company,
        'Careers discovery found a job board already linked to a different company (possible duplicate company or shared board).',
      );
    if (regional)
      await raiseRegionalLegacyReview(market, company, provider, input.boardToken, source, identity);
    return { sourceId: source._id, key: source.key, created };
  },
});

/**
 * v2 (OPS-2): board keys ignore case, as in the ats_boards import. A board already registered
 * under another case is the same board: it is returned, or, when it belongs to another company,
 * it gets the import's owner-conflict review and nothing is registered.
 */
export const registerJobSource = defineCapability({
  type: 'market.register_job_source',
  version: 2,
  title: 'Register Job Source',
  description:
    'Registers a discovered ATS board or careers page as a scheduled job source linked to its company.' +
    ' v2: the board key is built from the lowercased token and matched ignoring case; a board owned' +
    ' by another company raises an owner-conflict review and is not registered.',
  category: 'domain',
  inputSchema: registerJobSourceV1.inputSchema,
  outputSchema: registerJobSourceV1.outputSchema,
  configSchema: registerJobSourceV1.configSchema,
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Source registration is idempotent on its lowercased key (unique index, case-insensitive lookup first); a repeat returns the existing source; reviews are raised on deterministic dedupe keys.',
  },
  async execute(ctx, input, config) {
    const market = ctx.services.get(MARKET);
    const company = await market.companies.resolveActive(input.companyId);
    if (input.provider === 'careers_page')
      return registerCareersPage(ctx, market, company, input.url, config);
    const provider = input.provider as AtsProvider;
    if (!input.boardToken) throw new TerminalError('boardToken is required for ATS sources');
    let identity: BoardIdentity;
    try {
      // The stored token keeps its first-seen case for fetching; the key is lowercased.
      const key = atsBoardIdentity(provider, input.boardToken.toLowerCase(), input.apiBase).key;
      identity = { ...atsBoardIdentity(provider, input.boardToken, input.apiBase), key };
    } catch (err) {
      throw new TerminalError((err as Error).message);
    }
    const existing = await market.sources.getByKeyIgnoringCase(identity.key);
    if (existing && existing.companyId !== company._id) {
      await raiseBoardOwnerReview(
        market.reviews,
        existing,
        company,
        'Careers discovery found a job board already linked to a different company (possible duplicate company or shared board). Nothing was registered.',
      );
      return { sourceId: existing._id, key: existing.key, created: false };
    }
    const { source, created } = existing
      ? { source: existing, created: false }
      : await registerAtsBoard(
          market.sources,
          {
            company,
            provider,
            boardToken: input.boardToken,
            identity,
            refreshIntervalMinutes: config.refreshIntervalMinutes,
            enableSchedule: config.enableSchedule,
          },
          { kind: 'workflow', id: ctx.runId },
        );
    if (identity.region !== 'default')
      await raiseRegionalLegacyReview(market, company, provider, input.boardToken, source, identity, true);
    return { sourceId: source._id, key: source.key, created };
  },
});

/** True when `url` is on the company's official domain (or a subdomain) or its website host. */
export function isOnCompanyHosts(url: string, domain: string | null, website: string | null): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    host = u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  const hosts = new Set<string>();
  if (domain) hosts.add(domain.toLowerCase().replace(/^www\./, ''));
  if (website) {
    try {
      hosts.add(new URL(website).hostname.toLowerCase().replace(/^www\./, ''));
    } catch {
      /* no website host */
    }
  }
  for (const h of hosts) if (host === h || host.endsWith(`.${h}`)) return true;
  return false;
}

/**
 * Wave 6 (generic careers pages): after careers discovery, a company whose careers page is not on a
 * known ATS gets that page registered as a scheduled `careers_page` source (the host-scoped
 * `market.careers_page.crawl`: JSON-LD JobPosting extraction, never closing jobs by absence).
 *  - an ATS board was detected: nothing (the ATS source is authoritative and complete);
 *  - no careers URL: nothing;
 *  - the careers URL is off the company's official hosts (discovery's unfetched fallback link,
 *    e.g. a third-party page): not registered; a `careers_discovery` review asks an operator
 *    (ambiguity reaches review, source DoD 8). Crawling an unverified host is never automatic.
 */
export const registerCareersPageFallback = defineCapability({
  type: 'market.register_careers_page_fallback',
  version: 1,
  title: 'Register Careers Page (no ATS)',
  description:
    'Registers the discovered careers page as a scheduled careers_page source when no ATS board was found and the page is on the company’s official hosts; otherwise raises a review.',
  category: 'domain',
  inputSchema: z.object({
    companyId: z.string(),
    careersUrl: z.string().nullable(),
    /** The ATS boards discovery detected (only their number matters here). */
    ats: z.array(z.unknown()).nullable().optional(),
  }),
  outputSchema: z.object({
    outcome: z.enum(['registered', 'existing', 'ats_found', 'no_careers_url', 'off_domain_review']),
    sourceId: z.string().nullable(),
  }),
  configSchema: registerJobSourceV1.configSchema,
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Registration is idempotent on the careers_page:<host><path> key (unique index); the review is raised on a deterministic dedupe key (company + URL).',
  },
  async execute(ctx, input, config) {
    if ((input.ats?.length ?? 0) > 0) return { outcome: 'ats_found' as const, sourceId: null };
    if (!input.careersUrl) return { outcome: 'no_careers_url' as const, sourceId: null };
    const market = ctx.services.get(MARKET);
    const company = await market.companies.resolveActive(input.companyId);
    const domain = company.identity.domain.value ?? null;
    const website = company.identity.website.value ?? null;
    if (!isOnCompanyHosts(input.careersUrl, domain, website)) {
      await market.reviews.raise({
        type: 'careers_discovery',
        severity: 'low',
        dedupeKey: `careers_discovery:${company._id}:off_domain:${input.careersUrl}`,
        entity: { kind: 'company', id: company._id },
        subject: `${company.identity.displayName.value ?? company.identity.normalizedName}: careers link is off the official site`,
        reason: `Discovery found no ATS board; its careers link ${input.careersUrl} is not on ${domain ?? website ?? 'a known official host'}, so it was not registered for crawling.`,
        context: { careersUrl: input.careersUrl, domain, website },
        allowedActions: ['confirm', 'dismiss'],
      });
      return { outcome: 'off_domain_review' as const, sourceId: null };
    }
    const res = await registerCareersPage(ctx, market, company, input.careersUrl, config);
    return { outcome: res.created ? ('registered' as const) : ('existing' as const), sourceId: res.sourceId };
  },
});

const selectCompaniesInput = z.object({
  limit: z.number().int().min(1).max(1000).default(25),
  sponsorCountry: z.string().length(2).optional(),
  companyIds: z.array(z.string()).optional(),
});

/** v1 (runs pinned before OPS-1): any active company never attempted or past the careers policy. */
export const selectCompaniesForDiscoveryV1 = defineCapability({
  type: 'market.select_companies_for_discovery',
  version: 1,
  title: 'Select Companies Due for Careers Discovery',
  description: 'Returns companies never checked or checked longer ago than the careers freshness policy.',
  category: 'domain',
  inputSchema: selectCompaniesInput,
  outputSchema: z.object({ companyIds: z.array(z.string()) }),
  configSchema: z.object({}),
  execution: { retryable: true, idempotency: 'pure', sideEffects: false },
  async execute(ctx, input) {
    if (input.companyIds?.length) return { companyIds: input.companyIds.slice(0, input.limit) };
    return {
      companyIds: await ctx.services
        .get(MARKET)
        .freshness.companiesDueForCareersDiscovery(input.limit, input.sponsorCountry),
    };
  },
});

/**
 * v2 (OPS-1): only companies with a domain (discovery cannot run without one), never tried or
 * tried more than 30 days ago, oldest first. Given ids are filtered by the same rule.
 */
export const selectCompaniesForDiscovery = defineCapability({
  type: 'market.select_companies_for_discovery',
  version: 2,
  title: 'Select Companies Due for Careers Discovery',
  description:
    'Returns companies with a domain whose careers discovery never ran or last ran more than 30 days ago.',
  category: 'domain',
  inputSchema: selectCompaniesInput,
  outputSchema: z.object({ companyIds: z.array(z.string()) }),
  configSchema: z.object({}),
  execution: { retryable: true, idempotency: 'pure', sideEffects: false },
  async execute(ctx, input) {
    const freshness = ctx.services.get(MARKET).freshness;
    if (input.companyIds?.length)
      return {
        companyIds: (await freshness.filterDueForCareersDiscovery(input.companyIds)).slice(0, input.limit),
      };
    return {
      companyIds: await freshness.companiesWithDomainDueForCareers(input.limit, input.sponsorCountry),
    };
  },
});

/** Create Review Item: lets any workflow escalate material ambiguity through the domain. */
export const createReviewItem = defineCapability({
  type: 'market.create_review_item',
  version: 1,
  title: 'Create Review Item',
  description: 'Raises (or re-uses, by dedupe key) a review item for material ambiguity.',
  category: 'domain',
  inputSchema: z.object({
    type: z.enum(REVIEW_TYPES),
    severity: z.enum(['low', 'medium', 'high']),
    dedupeKey: z.string(),
    entity: z.object({ kind: z.enum(['company', 'job', 'observation', 'source']), id: z.string() }),
    subject: z.string(),
    reason: z.string(),
    context: jsonObjectSchema.default({}),
    allowedActions: z.array(z.enum(REVIEW_ACTIONS)).min(1),
  }),
  outputSchema: z.object({ reviewItemId: z.string(), created: z.boolean() }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Review items are raised idempotently on dedupeKey (unique among open items); a repeat increments nothing new.',
  },
  async execute(ctx, input) {
    const { item, created } = await ctx.services.get(MARKET).reviews.raise(input);
    return { reviewItemId: item._id, created };
  },
});

export const SYSTEM = SYSTEM_ACTOR;
