import { z } from 'zod';
import { artifactRefSchema, SYSTEM_ACTOR } from '@aptamind/contracts';
import {
  type CapabilityContext,
  defineCapability,
  recordSetSchema,
  TerminalError,
} from '@aptamind/workflow-sdk';
import { companyObservationPayloadSchema } from '../contracts/observations';
import { importReportSchema, reviewsOpenedSince, TraceCollector } from '../imports/import-report';
import { MARKET } from '../market-domain';
import {
  COMPANY_DIRECTORY_PARSER,
  DIRECTORY_REVIEW_REASONS,
  directoryConfigOf,
  planDirectoryImportAsync,
} from '../sources/providers/company-directory';

const rowErrorSchema = z.object({
  line: z.number().int(),
  code: z.string(),
  column: z.string().optional(),
  message: z.string(),
});

/** How many row errors travel in node outputs and reviews; the full list is in the report. */
const ERROR_SAMPLE = 100;

/**
 * Company directory (M8.1) — read the stored CSV snapshot with the source's column map and plan
 * the import: one company candidate per valid row, and a row error for every other row. The
 * full error list is stored as a JSON report artifact next to the snapshot; nothing is dropped
 * silently. A header that does not match the source's column map (or names personal data) is
 * refused before any row is read.
 */
export const mapCompanyDirectory = defineCapability({
  type: 'market.map_company_directory',
  version: 1,
  title: 'Map Company Directory',
  description:
    "Reads a company directory CSV snapshot with the source's column map into company candidates and a row-error report.",
  category: 'transform',
  inputSchema: z.object({ sourceId: z.string(), snapshotId: z.string(), artifact: artifactRefSchema }),
  outputSchema: z.object({
    records: recordSetSchema,
    rowCount: z.number().int(),
    importable: z.number().int(),
    errorCount: z.number().int(),
    errors: z.array(rowErrorSchema),
    /** Optional cells dropped from imported rows (the full list is in the report). */
    rowWarningCount: z.number().int(),
    report: artifactRefSchema.nullable(),
    warnings: z.array(z.string()),
  }),
  configSchema: z.object({}),
  execution: {
    // Pure and content-addressed: a transient failure (artifact read, record write) is retried.
    retryable: true,
    idempotency: 'pure',
    sideEffects: false,
    defaultTimeoutMs: 10 * 60_000,
    idempotencyProof:
      'Pure function of the stored snapshot bytes and the column map; the record set and report are content-addressed artifacts.',
  },
  async execute(ctx, input) {
    const market = ctx.services.get(MARKET);
    const source = await market.sources.get(input.sourceId);
    const config = directoryConfigOf(source);
    if (input.artifact.size > config.maxBytes)
      throw new TerminalError(
        `Snapshot is ${input.artifact.size} bytes; the source accepts at most ${config.maxBytes}`,
      );
    // The map yields the event loop and heartbeats the lease between batches of rows: a large or
    // slow file never loses its lease or blocks the worker (re-verification #12, M-4).
    const plan = await planDirectoryImportAsync(
      config,
      await ctx.artifacts.readText(input.artifact),
      source._id,
      async () => {
        // A timed-out, cancelled or lease-lost run stops here (DECISION_LOG 6bff30e).
        ctx.signal.throwIfAborted();
        await new Promise<void>((resolve) => setImmediate(resolve));
        ctx.signal.throwIfAborted();
        await ctx.heartbeat();
      },
    );
    if (plan.headerProblems.length)
      throw new TerminalError(`Header refused: ${plan.headerProblems.map((p) => p.message).join('; ')}`);
    if (plan.rowCount > config.maxRows)
      throw new TerminalError(
        `The file has ${plan.rowCount} rows; the source accepts at most ${config.maxRows}`,
      );
    const records = await ctx.records.write(plan.candidates, {
      sourceId: source._id,
      snapshotId: input.snapshotId,
    });
    const report =
      plan.errors.length || plan.rowWarnings.length
        ? await ctx.artifacts.putJson(
            {
              kind: 'company_directory_import_report',
              sourceId: source._id,
              snapshotId: input.snapshotId,
              parser: COMPANY_DIRECTORY_PARSER,
              rowCount: plan.rowCount,
              importable: plan.candidates.length,
              errors: plan.errors,
              rowWarnings: plan.rowWarnings,
              warnings: plan.warnings,
            },
            { sourceId: source._id, snapshotId: input.snapshotId, kind: 'import_report' },
          )
        : null;
    ctx.log.info('company directory mapped', {
      rows: plan.rowCount,
      importable: plan.candidates.length,
      errors: plan.errors.length,
    });
    return {
      records,
      rowCount: plan.rowCount,
      importable: plan.candidates.length,
      errorCount: plan.errors.length,
      errors: plan.errors.slice(0, ERROR_SAMPLE),
      rowWarningCount: plan.rowWarnings.length,
      report,
      warnings: plan.warnings,
    };
  },
});

/** One directory row → company observation (with snapshot provenance) → resolution → reconciliation. */
export const processDirectoryRow = defineCapability({
  type: 'market.process_directory_row',
  version: 1,
  title: 'Process Company Directory Row',
  description:
    'Records a directory row as a company observation with snapshot provenance, resolves it (review on ambiguity) and reconciles.',
  category: 'domain',
  inputSchema: z.object({
    sourceId: z.string(),
    snapshotId: z.string(),
    artifactId: z.string(),
    candidate: z.object({
      externalId: z.string().min(1),
      locator: z.string().min(1),
      payload: companyObservationPayloadSchema,
      review: z.enum(['conflicting_ids_in_file']).optional(),
    }),
  }),
  outputSchema: z.object({
    outcome: z.string(),
    observationId: z.string(),
    companyId: z.string().optional(),
    reviewItemId: z.string().optional(),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Observation id = hash(source, record key, payload); resolution is deterministic over unique identity keys with deduplicated reviews; reconciliation recomputes from evidence.',
  },
  async execute(ctx, input) {
    const r = await ctx.services.get(MARKET).companyPipeline.process(
      {
        sourceId: input.sourceId,
        snapshotId: input.snapshotId,
        artifactId: input.artifactId,
        locator: input.candidate.locator,
        externalId: input.candidate.externalId,
        payload: input.candidate.payload,
        parser: COMPANY_DIRECTORY_PARSER,
        runId: ctx.runId,
      },
      input.candidate.review ? { forceReview: DIRECTORY_REVIEW_REASONS[input.candidate.review] } : {},
    );
    return {
      outcome: r.outcome,
      observationId: r.observationId,
      companyId: 'companyId' in r ? r.companyId : undefined,
      reviewItemId: 'reviewItemId' in r ? r.reviewItemId : undefined,
    };
  },
});

/** Rows looked up per query when finalising (observation ids are deterministic). */
const FINALIZE_BATCH = 1000;

/** Most created or changed companies one import queues for careers discovery (the schedule takes the rest). */
export const DISCOVERY_QUEUE_MAX = 1000;

const finalizeDirectoryInput = z.object({
  sourceId: z.string(),
  snapshotId: z.string(),
  artifactId: z.string(),
  rowCount: z.number().int(),
  importable: z.number().int(),
  errorCount: z.number().int(),
  errors: z.array(rowErrorSchema),
  rowWarningCount: z.number().int().default(0),
  report: artifactRefSchema.nullable().optional(),
  records: recordSetSchema,
  warnings: z.array(z.string()).default([]),
  /** When the run started (its trigger): only reviews created since count as opened by it (OPS-1). */
  importStartedAt: z.coerce.date().optional(),
  fanout: z.object({
    total: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    sampleFailures: z.array(z.object({ index: z.number().int(), message: z.string() })).default([]),
  }),
});

const finalizeDirectoryOutputV1 = z.object({
  imported: z.number().int(),
  rowErrors: z.number().int(),
  rowWarnings: z.number().int(),
  processingFailures: z.number().int(),
  outcomes: z.object({
    matched: z.number().int(),
    created: z.number().int(),
    review: z.number().int(),
    failed: z.number().int(),
  }),
  reviewItemId: z.string().nullable(),
  report: artifactRefSchema.nullable(),
  warnings: z.array(z.string()),
});

const finalizeDirectoryOutput = finalizeDirectoryOutputV1.extend({
  /** Counts and trace for `GET /api/imports/:id` (OPS-1). */
  importReport: importReportSchema,
  /** Companies this run created or changed (at most `DISCOVERY_QUEUE_MAX`): discovery candidates. */
  changedCompanyIds: z.array(z.string()),
});

const finalizeDirectoryExecution = {
  retryable: true,
  idempotency: 'natural',
  sideEffects: true,
  idempotencyProof:
    'Outcomes are read from deterministic observation ids; the report is content-addressed; the review is deduplicated per (source, snapshot) and refreshed or resolved from the same facts; source health counts once per run; the snapshot item count is a set.',
} as const;

/**
 * Finalise a directory import. A directory is additive evidence: a company missing from a later
 * file is NOT delisted or closed (absence alone proves nothing).
 *
 * Every importable row's observation id is deterministic (source, record key, payload), so the
 * outcome of each row is read back: `matched` / `created` (resolved), `review`, or a processing
 * failure (no resolved-or-review observation) — with its file line. When rows were not imported
 * or failed, one `parser_failure` review per snapshot carries the counts, a sample and the full
 * JSON report (re-raising refreshes it to the latest run); `retry` is offered only when rows
 * failed processing (a retry cannot fix a row error). When a later run of the snapshot imports
 * every row, an open review for it is resolved automatically.
 */
async function finalizeDirectory(
  ctx: CapabilityContext,
  input: z.infer<typeof finalizeDirectoryInput>,
  version: 1 | 2,
): Promise<z.infer<typeof finalizeDirectoryOutput>> {
  const market = ctx.services.get(MARKET);
  const source = await market.sources.get(input.sourceId);
  // Which rows failed is read back below; the fan-out's failure messages are NOT copied into the
  // review or the report (an exception message may quote row text). They stay in the node logs.
  const failedInFanout = new Set(input.fanout.sampleFailures.map((f) => f.index));

  // Per-row outcome, read back through the deterministic observation ids.
  const outcomes = { matched: 0, created: 0, review: 0, failed: 0 };
  // created / updated / unchanged for the import report: a row is "new" when this run first
  // recorded its observation; a matched new row "updated" its company when the company changed
  // after the observation was recorded (reconciliation runs right after recording).
  const changes = { created: 0, updated: 0, unchanged: 0 };
  const trace = new TraceCollector();
  const rowReviews = new Set<string>();
  const changedCompanyIds = new Set<string>();
  const failures: Array<{ line: number; code: 'processing_failed'; message: string }> = [];
  let batch: Array<{ id: string; locator: string; index: number }> = [];
  let index = 0;
  const flush = async () => {
    if (!batch.length) return;
    const docs = await market.observations.companyObservations
      .find(
        { _id: { $in: batch.map((b) => b.id) } },
        { projection: { resolution: 1, runId: 1, createdAt: 1 } },
      )
      .toArray();
    const byId = new Map(docs.map((d) => [d._id, d]));
    const matchedNew = docs.filter(
      (d) =>
        d.resolution.state === 'resolved' &&
        d.resolution.method !== 'created' &&
        d.runId === ctx.runId &&
        d.resolution.entityId,
    );
    const changedAt = new Map(
      matchedNew.length
        ? (
            await market.companies.col
              .find(
                { _id: { $in: matchedNew.map((d) => d.resolution.entityId!) } },
                { projection: { 'freshness.lastChangedAt': 1 } },
              )
              .toArray()
          ).map((c) => [c._id, c.freshness?.lastChangedAt ?? null])
        : [],
    );
    for (const b of batch) {
      const doc = byId.get(b.id);
      const r = doc?.resolution;
      if (r?.state === 'resolved') {
        const created = r.method === 'created';
        outcomes[created ? 'created' : 'matched']++;
        trace.add('companyIds', r.entityId);
        const fresh = doc!.runId === ctx.runId;
        const at = r.entityId ? changedAt.get(r.entityId) : null;
        const kind =
          created && fresh
            ? 'created'
            : !created && fresh && at && at.getTime() >= doc!.createdAt.getTime()
              ? 'updated'
              : 'unchanged';
        changes[kind]++;
        if (kind !== 'unchanged' && r.entityId && changedCompanyIds.size < DISCOVERY_QUEUE_MAX)
          changedCompanyIds.add(r.entityId);
      } else if (r?.state === 'review') {
        outcomes.review++;
        if (r.reviewItemId) rowReviews.add(r.reviewItemId);
      } else {
        outcomes.failed++;
        failures.push({
          line: Number(b.locator.replace(/^row:/, '')) || 0,
          code: 'processing_failed',
          message: failedInFanout.has(b.index)
            ? 'the row failed processing (the error is in the run node logs)'
            : r
              ? `the observation is ${r.state}`
              : 'the row was not processed',
        });
      }
    }
    batch = [];
  };
  for await (const c of ctx.records.read(input.records)) {
    const candidate = c as { externalId: string; locator: string; payload: never };
    batch.push({
      id: market.observations.companyObservationId(source._id, candidate.externalId, candidate.payload),
      locator: candidate.locator,
      index: index++,
    });
    if (batch.length >= FINALIZE_BATCH) await flush();
  }
  await flush();

  const failed = failures.length;
  const dedupeKey = `parser_failure:${source._id}:${input.snapshotId}`;
  let reviewItemId: string | null = null;
  let report: z.infer<typeof artifactRefSchema> | null = null;
  // Every row error (the node input carries a sample only): from the map report when there is one.
  // v2 throws on a failed read (the step is retryable, and a sample would give wrong counts); v1
  // keeps its behaviour and falls back to the sample.
  const sample = { errors: input.errors as Array<{ code: string }>, rowWarnings: [] as unknown[] };
  const readMapped = (ref: z.infer<typeof artifactRefSchema>) => {
    const read = ctx.artifacts.readJson<{ errors: Array<{ code: string }>; rowWarnings?: unknown[] }>(ref);
    return version === 2
      ? read
      : read.catch((err: unknown) => {
          ctx.log.warn('map report unreadable; the report uses the error sample', { error: String(err) });
          return sample;
        });
  };
  // v2 also writes the report for file-level warnings, which the import report counts (OPS-1b: a
  // run showed warnings with no report to read them in).
  const warned = input.rowWarningCount > 0 || (version === 2 && input.warnings.length > 0);
  const mapped =
    input.report && (input.errorCount > 0 || failed > 0 || input.rowWarningCount > 0)
      ? await readMapped(input.report)
      : sample;
  if (input.errorCount > 0 || failed > 0 || warned) {
    // The full report: every row error and dropped cell (from the map report) and every
    // processing failure.
    report = await ctx.artifacts.putJson(
      {
        kind: 'company_directory_import_report',
        sourceId: source._id,
        snapshotId: input.snapshotId,
        parser: COMPANY_DIRECTORY_PARSER,
        rowCount: input.rowCount,
        importable: input.importable,
        outcomes,
        warnings: input.warnings,
        errors: mapped.errors,
        rowWarnings: mapped.rowWarnings ?? [],
        processingFailures: failures,
      },
      { sourceId: source._id, snapshotId: input.snapshotId, kind: 'import_report' },
    );
  }
  if (input.errorCount > 0 || failed > 0) {
    const parts = [
      input.errorCount ? `${input.errorCount} of ${input.rowCount} rows were not imported` : null,
      failed ? `${failed} of ${input.importable} rows failed processing` : null,
    ].filter(Boolean);
    const sample = [
      ...input.errors.slice(0, 5).map((e) => `line ${e.line}: ${e.message}`),
      ...failures.slice(0, 5).map((f) => `line ${f.line}: ${f.message}`),
    ]
      .slice(0, 5)
      .join('; ');
    const { item } = await market.reviews.raise({
      type: 'parser_failure',
      severity: input.importable === 0 ? 'high' : 'medium',
      dedupeKey,
      entity: { kind: 'source', id: source._id },
      subject: `${source.name}: ${parts.join('; ')}`,
      reason: `${parts.join('; ')}.${sample ? ` First problems: ${sample}.` : ''} ${
        failed
          ? 'Retry re-processes the failed rows; fix row errors in the file and upload it again.'
          : 'Fix the rows and upload the file again.'
      }`.slice(0, 2000),
      evidence: [
        {
          sourceId: source._id,
          snapshotId: input.snapshotId,
          artifactId: report!.artifactId,
          observedAt: ctx.clock.now(),
        },
      ],
      context: {
        sourceId: source._id,
        snapshotId: input.snapshotId,
        runId: ctx.runId,
        rowCount: input.rowCount,
        rowErrors: input.errorCount,
        rowWarnings: input.rowWarningCount,
        processingFailures: failed,
        outcomes,
        reportArtifactId: report!.artifactId,
        errors: input.errors.slice(0, 20).map((e) => ({ ...e })),
        failures: failures.slice(0, 20),
        retryInput: { snapshotId: input.snapshotId },
      },
      // A retry re-processes the snapshot: it only helps rows that failed processing.
      allowedActions: failed > 0 ? ['retry', 'dismiss'] : ['dismiss'],
      refresh: true,
    });
    reviewItemId = item._id;
  } else {
    const closed = await market.reviews.resolveObsolete(
      dedupeKey,
      'A later run of this snapshot imported every row (no row errors, no processing failures).',
      { runId: ctx.runId, imported: input.fanout.succeeded },
    );
    if (closed)
      await market.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'review.resolved_obsolete',
        entity: { kind: 'review_item', id: closed._id },
        reviewItemId: closed._id,
        runId: ctx.runId,
        idempotencyKey: `${closed._id}:obsolete`,
        details: { snapshotId: input.snapshotId },
      });
  }
  await market.observations.setSnapshotItemCount(input.snapshotId, input.rowCount);
  const imported = outcomes.matched + outcomes.created + outcomes.review;
  if (input.rowCount > 0 && imported === 0)
    await market.sources.recordFailure(
      source._id,
      'company directory import: no row was imported',
      ctx.runId,
    );
  else
    await market.sources.recordSuccess(source._id, {
      snapshotId: input.snapshotId,
      itemCount: imported,
      runId: ctx.runId,
    });
  ctx.log.info('company directory import finalised', {
    ...outcomes,
    rowErrors: input.errorCount,
  });
  const byCode = (code: string) => mapped.errors.filter((e) => e.code === code).length;
  const ignored = byCode('duplicate_row_key');
  // Only reviews this run opened count (a review raised again by a re-import is not new).
  const reviewIds = [...rowReviews, ...(reviewItemId ? [reviewItemId] : [])];
  const opened =
    version === 2 && input.importStartedAt
      ? await reviewsOpenedSince(market.reviews.col, reviewIds, input.importStartedAt)
      : [...new Set(reviewIds)];
  for (const id of opened) trace.add('reviewIds', id);
  return {
    imported,
    rowErrors: input.errorCount,
    rowWarnings: input.rowWarningCount,
    processingFailures: failed,
    outcomes,
    reviewItemId,
    report,
    warnings: input.warnings,
    importReport: {
      counts: {
        rows: input.rowCount,
        parsed: input.rowCount - byCode('malformed_row'),
        accepted: imported,
        ...changes,
        ignored,
        failed: input.errorCount - ignored + failed,
        reviews: opened.length,
        warnings: input.rowWarningCount + input.warnings.length,
      },
      trace: { ...trace.result(), reportArtifactId: report?.artifactId ?? null },
    },
    changedCompanyIds: [...changedCompanyIds],
  };
}

/** v1 (runs pinned to the workflow version before OPS-1): the same step without the import report. */
export const finalizeDirectoryImportV1 = defineCapability({
  type: 'market.finalize_directory_import',
  version: 1,
  title: 'Finalize Company Directory Import',
  description:
    'Records the import outcome and raises (or clears) the review for rows that were not imported.',
  category: 'domain',
  inputSchema: finalizeDirectoryInput,
  outputSchema: finalizeDirectoryOutputV1,
  configSchema: z.object({}),
  execution: finalizeDirectoryExecution,
  async execute(ctx, input) {
    const {
      importReport: _report,
      changedCompanyIds: _changed,
      ...v1
    } = await finalizeDirectory(ctx, input, 1);
    return v1;
  },
});

/** v2 (OPS-1): adds the import report (counts and trace) and the companies to queue for discovery. */
export const finalizeDirectoryImport = defineCapability({
  type: 'market.finalize_directory_import',
  version: 2,
  title: 'Finalize Company Directory Import',
  description:
    'Records the import outcome, raises (or clears) the review for rows that were not imported, and reports counts and trace. Changed in place in OPS-1b: the report is also written when the run has only file-level warnings (additive; a content-addressed artifact).',
  category: 'domain',
  inputSchema: finalizeDirectoryInput,
  outputSchema: finalizeDirectoryOutput,
  configSchema: z.object({}),
  execution: finalizeDirectoryExecution,
  execute: (ctx, input) => finalizeDirectory(ctx, input, 2),
});
