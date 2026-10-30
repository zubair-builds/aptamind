import { z } from 'zod';
import { artifactRefSchema, SYSTEM_ACTOR } from '@aptamind/contracts';
import { defineCapability, recordSetSchema, TerminalError } from '@aptamind/workflow-sdk';
import { importReportSchema, reviewsOpenedSince, TraceCollector } from '../imports/import-report';
import { NET_CLIENT } from '@aptamind/workflow-nodes';
import { MARKET } from '../market-domain';
import { processBoardRow } from '../sources/ats-board-import';
import { processBoardRowV2 } from '../sources/board-identity-import';
import { probeBoardLiveness } from '../sources/board-liveness';
import {
  ATS_BOARD_DIRECTORY_PARSER,
  ATS_BOARD_DIRECTORY_PARSER_V1,
  type BoardRow,
  boardDirectoryConfigOf,
  planBoardDirectory,
} from '../sources/providers/ats-board-directory';

/** How many row errors travel in node outputs and reviews; the full list is in the report. */
const ERROR_SAMPLE = 100;

const rowErrorSchema = z.object({
  line: z.number().int(),
  code: z.string(),
  column: z.string().optional(),
  message: z.string(),
});

/**
 * After a company import (OPS-1): queue careers discovery for the companies the import created
 * or changed that are due (a domain, never tried or tried more than 30 days ago).
 */
export const queueCareersDiscovery = defineCapability({
  type: 'market.queue_careers_discovery',
  version: 1,
  title: 'Queue Careers Discovery',
  description:
    'Queues careers discovery batch runs for imported companies that have a domain and are due (keyed per run, so a retry queues nothing twice).',
  category: 'domain',
  inputSchema: z.object({ companyIds: z.array(z.string()).default([]) }),
  outputSchema: z.object({ due: z.number().int(), queued: z.number().int(), runIds: z.array(z.string()) }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Each queued batch run carries the idempotency key careers_discovery:import:<runId>:<chunk>; a retry finds the same runs.',
  },
  async execute(ctx, input) {
    return ctx.services.get(MARKET).queueCareersDiscovery(input.companyIds, `import:${ctx.runId}`);
  },
});

const boardRowSchema = z.object({
  line: z.number().int(),
  locator: z.string().min(1),
  provider: z.enum(['greenhouse', 'ashby', 'lever']),
  boardToken: z.string().min(1),
  apiBase: z.string().url(),
  region: z.string(),
  key: z.string().min(1),
  company: z.string().nullable(),
  domain: z.string().nullable(),
});

/**
 * Known ATS board file (M8.2): read the stored CSV snapshot with the source's column map into one
 * board row per valid row and a row error for every other row. A header that does not match the
 * column map (or names personal data) is refused before any row is read.
 */
export const mapAtsBoardDirectory = defineCapability({
  type: 'market.map_ats_board_directory',
  version: 1,
  title: 'Map ATS Board File',
  description:
    "Reads a known ATS board CSV snapshot with the source's column map into board rows and a row-error report.",
  category: 'transform',
  inputSchema: z.object({ sourceId: z.string(), snapshotId: z.string(), artifact: artifactRefSchema }),
  outputSchema: z.object({
    records: recordSetSchema,
    rowCount: z.number().int(),
    importable: z.number().int(),
    errorCount: z.number().int(),
    errors: z.array(rowErrorSchema),
    report: artifactRefSchema.nullable(),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'pure',
    sideEffects: false,
    defaultTimeoutMs: 5 * 60_000,
    idempotencyProof:
      'Pure function of the stored snapshot bytes and the column map; the record set and report are content-addressed artifacts.',
  },
  async execute(ctx, input) {
    const market = ctx.services.get(MARKET);
    const source = await market.sources.get(input.sourceId);
    const config = boardDirectoryConfigOf(source);
    if (input.artifact.size > config.maxBytes)
      throw new TerminalError(
        `Snapshot is ${input.artifact.size} bytes; the source accepts at most ${config.maxBytes}`,
      );
    const plan = planBoardDirectory(config, await ctx.artifacts.readText(input.artifact), { legacy: true });
    if (plan.headerProblems.length)
      throw new TerminalError(`Header refused: ${plan.headerProblems.map((p) => p.message).join('; ')}`);
    if (plan.rowCount > config.maxRows)
      throw new TerminalError(
        `The file has ${plan.rowCount} rows; the source accepts at most ${config.maxRows}`,
      );
    const records = await ctx.records.write(plan.rows, {
      sourceId: source._id,
      snapshotId: input.snapshotId,
    });
    const report = plan.errors.length
      ? await ctx.artifacts.putJson(
          {
            kind: 'ats_board_import_report',
            sourceId: source._id,
            snapshotId: input.snapshotId,
            parser: ATS_BOARD_DIRECTORY_PARSER_V1,
            rowCount: plan.rowCount,
            importable: plan.rows.length,
            errors: plan.errors,
          },
          { sourceId: source._id, snapshotId: input.snapshotId, kind: 'import_report' },
        )
      : null;
    ctx.log.info('ATS board file mapped', {
      rows: plan.rowCount,
      importable: plan.rows.length,
      errors: plan.errors.length,
    });
    return {
      records,
      rowCount: plan.rowCount,
      importable: plan.rows.length,
      errorCount: plan.errors.length,
      errors: plan.errors.slice(0, ERROR_SAMPLE),
      report,
    };
  },
});

const boardRowOutputSchema = z.object({
  outcome: z.enum(['registered', 'unchanged', 'review', 'other_owner']),
  observationId: z.string(),
  companyId: z.string().optional(),
  sourceId: z.string().optional(),
  reviewItemId: z.string().optional(),
});

/** One board row → company observation → attach-only resolution → job source (or a review). */
export const processAtsBoardRow = defineCapability({
  type: 'market.process_ats_board_row',
  version: 1,
  title: 'Process ATS Board Row',
  description:
    "Records a board row as an observation, attaches it to an existing company (review when unresolved or ambiguous) and registers the board as that company's job source (review when another company owns it).",
  category: 'domain',
  inputSchema: z.object({
    sourceId: z.string(),
    snapshotId: z.string(),
    artifactId: z.string(),
    row: boardRowSchema,
  }),
  outputSchema: boardRowOutputSchema,
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Observation id = hash(source, board key, payload); reviews are deduplicated; the job source is unique on its board key and is never re-registered or moved.',
  },
  async execute(ctx, input) {
    return processBoardRow(
      ctx.services.get(MARKET),
      { ...input, row: input.row as BoardRow, runId: ctx.runId },
      { kind: 'workflow', id: ctx.runId },
    );
  },
});

const finalizeBoardInput = z.object({
  sourceId: z.string(),
  snapshotId: z.string(),
  rowCount: z.number().int(),
  importable: z.number().int(),
  errorCount: z.number().int(),
  errors: z.array(rowErrorSchema),
  report: artifactRefSchema.nullable().optional(),
  /** When the run started (its trigger): only reviews created since count as opened by it. */
  importStartedAt: z.coerce.date().optional(),
  fanout: z.object({
    total: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    outputs: z.array(z.unknown().nullable()).default([]),
  }),
});

/**
 * Finalise a board file import. Like a directory, a board file is additive: a board missing from
 * a later file is not removed. Rows that were not imported or failed processing raise one
 * `parser_failure` review per snapshot (resolved when a later run imports every row).
 */
export const finalizeAtsBoardImport = defineCapability({
  type: 'market.finalize_ats_board_import',
  version: 1,
  title: 'Finalize ATS Board Import',
  description:
    'Counts board outcomes, raises (or clears) the review for rows that were not imported, and reports counts and trace.',
  category: 'domain',
  inputSchema: finalizeBoardInput,
  outputSchema: z.object({
    outcomes: z.object({
      registered: z.number().int(),
      unchanged: z.number().int(),
      review: z.number().int(),
      otherOwner: z.number().int(),
      failed: z.number().int(),
    }),
    reviewItemId: z.string().nullable(),
    report: artifactRefSchema.nullable(),
    importReport: importReportSchema,
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Outcomes come from the fan-out outputs; the report is content-addressed; the review is deduplicated per (source, snapshot); source health counts once per run.',
  },
  async execute(ctx, input) {
    const market = ctx.services.get(MARKET);
    const source = await market.sources.get(input.sourceId);
    const outcomes = { registered: 0, unchanged: 0, review: 0, otherOwner: 0, failed: 0 };
    const trace = new TraceCollector();
    const rowReviews = new Set<string>();
    for (let i = 0; i < input.fanout.total; i++) {
      const parsed = boardRowOutputSchema.safeParse(input.fanout.outputs[i]);
      // A failed row has no output (its error is in the node logs, never copied: it may quote row text).
      if (!parsed.success) {
        outcomes.failed++;
        continue;
      }
      const r = parsed.data;
      outcomes[r.outcome === 'other_owner' ? 'otherOwner' : r.outcome]++;
      trace.add('companyIds', r.companyId);
      trace.add('sourceIds', r.sourceId);
      if (r.reviewItemId) rowReviews.add(r.reviewItemId);
    }

    const mapped =
      input.report && input.errorCount > 0
        ? await ctx.artifacts.readJson<{ errors: Array<{ code: string }> }>(input.report)
        : { errors: input.errors };
    const dedupeKey = `parser_failure:${source._id}:${input.snapshotId}`;
    let reviewItemId: string | null = null;
    let report: z.infer<typeof artifactRefSchema> | null = null;
    if (input.errorCount > 0 || outcomes.failed > 0) {
      report = await ctx.artifacts.putJson(
        {
          kind: 'ats_board_import_report',
          sourceId: source._id,
          snapshotId: input.snapshotId,
          parser: ATS_BOARD_DIRECTORY_PARSER_V1,
          rowCount: input.rowCount,
          importable: input.importable,
          outcomes,
          errors: mapped.errors,
        },
        { sourceId: source._id, snapshotId: input.snapshotId, kind: 'import_report' },
      );
      const parts = [
        input.errorCount ? `${input.errorCount} of ${input.rowCount} rows were not imported` : null,
        outcomes.failed ? `${outcomes.failed} of ${input.importable} rows failed processing` : null,
      ].filter(Boolean);
      const sample = input.errors
        .slice(0, 5)
        .map((e) => `line ${e.line}: ${e.message}`)
        .join('; ');
      const { item } = await market.reviews.raise({
        type: 'parser_failure',
        severity: input.importable === 0 ? 'high' : 'medium',
        dedupeKey,
        entity: { kind: 'source', id: source._id },
        subject: `${source.name}: ${parts.join('; ')}`,
        reason: `${parts.join('; ')}.${sample ? ` First problems: ${sample}.` : ''} ${
          outcomes.failed
            ? 'Retry re-processes the failed rows; fix row errors in the file and upload it again.'
            : 'Fix the rows and upload the file again.'
        }`.slice(0, 2000),
        evidence: [
          {
            sourceId: source._id,
            snapshotId: input.snapshotId,
            artifactId: report.artifactId,
            observedAt: ctx.clock.now(),
          },
        ],
        context: {
          sourceId: source._id,
          snapshotId: input.snapshotId,
          runId: ctx.runId,
          rowCount: input.rowCount,
          rowErrors: input.errorCount,
          processingFailures: outcomes.failed,
          outcomes,
          reportArtifactId: report.artifactId,
          errors: input.errors.slice(0, 20).map((e) => ({ ...e })),
          retryInput: { snapshotId: input.snapshotId },
        },
        allowedActions: outcomes.failed > 0 ? ['retry', 'dismiss'] : ['dismiss'],
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
    const accepted = outcomes.registered + outcomes.unchanged + outcomes.review + outcomes.otherOwner;
    if (input.rowCount > 0 && accepted === 0)
      await market.sources.recordFailure(source._id, 'ATS board import: no row was imported', ctx.runId);
    else
      await market.sources.recordSuccess(source._id, {
        snapshotId: input.snapshotId,
        itemCount: accepted,
        runId: ctx.runId,
      });
    ctx.log.info('ATS board import finalised', { ...outcomes, rowErrors: input.errorCount });
    const byCode = (code: string) => mapped.errors.filter((e) => e.code === code).length;
    const ignored = byCode('duplicate_row_key');
    // Only reviews this run opened count (a review raised again by a re-import is not new).
    const reviewIds = [...rowReviews, ...(reviewItemId ? [reviewItemId] : [])];
    const opened = input.importStartedAt
      ? await reviewsOpenedSince(market.reviews.col, reviewIds, input.importStartedAt)
      : [...new Set(reviewIds)];
    for (const id of opened) trace.add('reviewIds', id);
    return {
      outcomes,
      reviewItemId,
      report,
      importReport: {
        counts: {
          rows: input.rowCount,
          parsed: input.rowCount - byCode('malformed_row'),
          accepted,
          created: outcomes.registered,
          // A board file never changes an existing job source.
          updated: 0,
          unchanged: outcomes.unchanged,
          ignored,
          failed: input.errorCount - ignored + outcomes.failed,
          reviews: opened.length,
          // A board file has no row warnings today; row problems are errors.
          warnings: 0,
        },
        trace: { ...trace.result(), reportArtifactId: report?.artifactId ?? null },
      },
    };
  },
});

// --- OPS-1b: a live board is company identity evidence (version 2 of the three board nodes) ---

const rowWarningSchema = z.object({
  line: z.number().int(),
  code: z.string(),
  column: z.string().optional(),
  message: z.string(),
  skipped: z.boolean(),
});

/**
 * Version 2 (OPS-1b): a board may come from a job or board URL alone (provider and token are
 * derived on the server); a URL that is not a known ATS board is a row warning, never an error.
 * The report exists whenever a row has an error or a warning.
 */
export const mapAtsBoardDirectoryV2 = defineCapability({
  ...mapAtsBoardDirectory,
  version: 2,
  description:
    "Reads a known ATS board CSV snapshot with the source's column map into board rows (provider and token from the columns or derived from a board URL), row errors and row warnings.",
  outputSchema: z.object({
    records: recordSetSchema,
    rowCount: z.number().int(),
    importable: z.number().int(),
    errorCount: z.number().int(),
    errors: z.array(rowErrorSchema),
    warningCount: z.number().int(),
    /** Warning rows that had no other board, so nothing was imported from them. */
    skippedCount: z.number().int(),
    warnings: z.array(rowWarningSchema),
    report: artifactRefSchema.nullable(),
  }),
  async execute(ctx, input) {
    const market = ctx.services.get(MARKET);
    const source = await market.sources.get(input.sourceId);
    const config = boardDirectoryConfigOf(source);
    if (input.artifact.size > config.maxBytes)
      throw new TerminalError(
        `Snapshot is ${input.artifact.size} bytes; the source accepts at most ${config.maxBytes}`,
      );
    const plan = planBoardDirectory(config, await ctx.artifacts.readText(input.artifact));
    if (plan.headerProblems.length)
      throw new TerminalError(`Header refused: ${plan.headerProblems.map((p) => p.message).join('; ')}`);
    if (plan.rowCount > config.maxRows)
      throw new TerminalError(
        `The file has ${plan.rowCount} rows; the source accepts at most ${config.maxRows}`,
      );
    const records = await ctx.records.write(
      plan.rows.map(({ warning: _warning, ...row }) => row),
      { sourceId: source._id, snapshotId: input.snapshotId },
    );
    const report =
      plan.errors.length || plan.warnings.length
        ? await ctx.artifacts.putJson(
            {
              kind: 'ats_board_import_report',
              sourceId: source._id,
              snapshotId: input.snapshotId,
              parser: ATS_BOARD_DIRECTORY_PARSER,
              rowCount: plan.rowCount,
              importable: plan.rows.length,
              errors: plan.errors,
              warnings: plan.warnings,
            },
            { sourceId: source._id, snapshotId: input.snapshotId, kind: 'import_report' },
          )
        : null;
    ctx.log.info('ATS board file mapped', {
      rows: plan.rowCount,
      importable: plan.rows.length,
      errors: plan.errors.length,
      warnings: plan.warnings.length,
    });
    return {
      records,
      rowCount: plan.rowCount,
      importable: plan.rows.length,
      errorCount: plan.errors.length,
      errors: plan.errors.slice(0, ERROR_SAMPLE),
      warningCount: plan.warnings.length,
      skippedCount: plan.warnings.filter((w) => w.skipped).length,
      warnings: plan.warnings.slice(0, ERROR_SAMPLE),
      report,
    };
  },
});

const boardRowFailureCodes = ['board_not_live', 'board_unreachable', 'no_identity'] as const;

const boardRowOutputSchemaV2 = z.discriminatedUnion('outcome', [
  boardRowOutputSchema.extend({
    outcome: z.enum(['registered', 'unchanged', 'review', 'other_owner']),
    companyCreated: z.boolean().optional(),
  }),
  z.object({
    outcome: z.literal('failed'),
    code: z.enum(boardRowFailureCodes),
    line: z.number().int(),
    /** A fixed explanation or the HTTP status; never response or cell text. */
    reason: z.string(),
  }),
]);

/**
 * Version 2 (OPS-1b): the board's own source, then domain, `ats` id and a unique exact name
 * attach as before; with no match, one liveness fetch decides. A live board anchors a new company
 * (its `ats` id) and becomes its job source, the fetched listing its first snapshot.
 */
export const processAtsBoardRowV2 = defineCapability({
  ...processAtsBoardRow,
  version: 2,
  description:
    'Resolves a board row to a company (board source, domain, ats id, unique exact name; review when ambiguous). With no match it fetches the board once: a live board creates a board-anchored company and registers the board; a board that is not live or unreachable fails the row and creates nothing.',
  outputSchema: boardRowOutputSchemaV2,
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    // The liveness fetch waits behind the shared per-host limiter (many boards share one host).
    defaultTimeoutMs: 3 * 60_000,
    idempotencyProof:
      'Observation id = hash(source, board key, payload); the job source is unique on its board key and is claimed for the company id hash(board key) before that company is created, so a replay or a concurrent run finds the same claim and company; owner changes are conditional; the company and its creation event (keyed per board) commit together; its first snapshot id is hash(source, bytes); reviews are deduplicated.',
  },
  async execute(ctx, input) {
    const http = ctx.services.get(NET_CLIENT);
    const row = input.row as BoardRow;
    return processBoardRowV2(
      ctx.services.get(MARKET),
      { ...input, row, runId: ctx.runId },
      (r) =>
        probeBoardLiveness(
          {
            http,
            putArtifact: (body, contentType) =>
              ctx.artifacts.put(body, contentType, { sourceId: input.sourceId, kind: 'board_liveness' }),
            signal: ctx.signal,
          },
          { provider: r.provider, boardToken: r.boardToken, apiBase: r.apiBase },
        ),
      { kind: 'workflow', id: ctx.runId },
    );
  },
});

const finalizeBoardInputV2 = finalizeBoardInput.extend({
  warningCount: z.number().int().default(0),
  skippedCount: z.number().int().default(0),
  warnings: z.array(rowWarningSchema).default([]),
});

/**
 * Version 2 (OPS-1b). Rows that failed a decided check (board not live, unreachable, no identity)
 * count as failed and are listed in the report, but open no review: re-importing the file retries
 * them. Map errors and thrown row failures raise the `parser_failure` review as in version 1. The
 * report exists, and is linked, whenever a row has an error, a warning or a failure.
 */
export const finalizeAtsBoardImportV2 = defineCapability({
  ...finalizeAtsBoardImport,
  version: 2,
  description:
    'Counts board outcomes (companies created from live boards, boards not live or unreachable), raises (or clears) the review for rows that were not imported, and reports counts, warnings and trace.',
  inputSchema: finalizeBoardInputV2,
  outputSchema: z.object({
    outcomes: z.object({
      registered: z.number().int(),
      unchanged: z.number().int(),
      review: z.number().int(),
      otherOwner: z.number().int(),
      failed: z.number().int(),
      companiesCreated: z.number().int(),
      notLive: z.number().int(),
      unreachable: z.number().int(),
      noIdentity: z.number().int(),
    }),
    reviewItemId: z.string().nullable(),
    report: artifactRefSchema.nullable(),
    importReport: importReportSchema,
  }),
  async execute(ctx, input) {
    const market = ctx.services.get(MARKET);
    const source = await market.sources.get(input.sourceId);
    const outcomes = {
      registered: 0,
      unchanged: 0,
      review: 0,
      otherOwner: 0,
      failed: 0,
      companiesCreated: 0,
      notLive: 0,
      unreachable: 0,
      noIdentity: 0,
    };
    const decidedKey = {
      board_not_live: 'notLive',
      board_unreachable: 'unreachable',
      no_identity: 'noIdentity',
    } as const;
    const rowFailures: Array<{ line: number; code: string; reason: string }> = [];
    const trace = new TraceCollector();
    const rowReviews = new Set<string>();
    for (let i = 0; i < input.fanout.total; i++) {
      const parsed = boardRowOutputSchemaV2.safeParse(input.fanout.outputs[i]);
      // A thrown row has no output (its error is in the node logs, never copied: it may quote row text).
      if (!parsed.success) {
        outcomes.failed++;
        continue;
      }
      const r = parsed.data;
      if (r.outcome === 'failed') {
        outcomes[decidedKey[r.code]]++;
        rowFailures.push({ line: r.line, code: r.code, reason: r.reason });
        continue;
      }
      outcomes[r.outcome === 'other_owner' ? 'otherOwner' : r.outcome]++;
      if (r.companyCreated) outcomes.companiesCreated++;
      trace.add('companyIds', r.companyId);
      trace.add('sourceIds', r.sourceId);
      if (r.reviewItemId) rowReviews.add(r.reviewItemId);
    }
    const decidedFailures = outcomes.notLive + outcomes.unreachable + outcomes.noIdentity;

    const mapped =
      input.report && (input.errorCount > 0 || input.warningCount > 0)
        ? await ctx.artifacts.readJson<{ errors: Array<{ code: string }>; warnings?: unknown[] }>(
            input.report,
          )
        : { errors: input.errors, warnings: input.warnings };
    const report =
      input.errorCount > 0 || input.warningCount > 0 || outcomes.failed > 0 || decidedFailures > 0
        ? await ctx.artifacts.putJson(
            {
              kind: 'ats_board_import_report',
              sourceId: source._id,
              snapshotId: input.snapshotId,
              parser: ATS_BOARD_DIRECTORY_PARSER,
              rowCount: input.rowCount,
              importable: input.importable,
              outcomes,
              errors: mapped.errors,
              warnings: mapped.warnings ?? input.warnings,
              rowFailures: rowFailures.sort((a, b) => a.line - b.line),
            },
            { sourceId: source._id, snapshotId: input.snapshotId, kind: 'import_report' },
          )
        : null;

    const dedupeKey = `parser_failure:${source._id}:${input.snapshotId}`;
    let reviewItemId: string | null = null;
    if (report && (input.errorCount > 0 || outcomes.failed > 0)) {
      const parts = [
        input.errorCount ? `${input.errorCount} of ${input.rowCount} rows were not imported` : null,
        outcomes.failed ? `${outcomes.failed} of ${input.importable} rows failed processing` : null,
      ].filter(Boolean);
      const sample = input.errors
        .slice(0, 5)
        .map((e) => `line ${e.line}: ${e.message}`)
        .join('; ');
      const { item } = await market.reviews.raise({
        type: 'parser_failure',
        severity: input.importable === 0 ? 'high' : 'medium',
        dedupeKey,
        entity: { kind: 'source', id: source._id },
        subject: `${source.name}: ${parts.join('; ')}`,
        reason: `${parts.join('; ')}.${sample ? ` First problems: ${sample}.` : ''} ${
          outcomes.failed
            ? 'Retry re-processes the failed rows; fix row errors in the file and upload it again.'
            : 'Fix the rows and upload the file again.'
        }`.slice(0, 2000),
        evidence: [
          {
            sourceId: source._id,
            snapshotId: input.snapshotId,
            artifactId: report.artifactId,
            observedAt: ctx.clock.now(),
          },
        ],
        context: {
          sourceId: source._id,
          snapshotId: input.snapshotId,
          runId: ctx.runId,
          rowCount: input.rowCount,
          rowErrors: input.errorCount,
          processingFailures: outcomes.failed,
          outcomes,
          reportArtifactId: report.artifactId,
          errors: input.errors.slice(0, 20).map((e) => ({ ...e })),
          retryInput: { snapshotId: input.snapshotId },
        },
        allowedActions: outcomes.failed > 0 ? ['retry', 'dismiss'] : ['dismiss'],
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
    const accepted = outcomes.registered + outcomes.unchanged + outcomes.review + outcomes.otherOwner;
    if (input.rowCount > 0 && accepted === 0)
      await market.sources.recordFailure(source._id, 'ATS board import: no row was imported', ctx.runId);
    else
      await market.sources.recordSuccess(source._id, {
        snapshotId: input.snapshotId,
        itemCount: accepted,
        runId: ctx.runId,
      });
    ctx.log.info('ATS board import finalised', {
      ...outcomes,
      rowErrors: input.errorCount,
      rowWarnings: input.warningCount,
    });
    const byCode = (code: string) => mapped.errors.filter((e) => e.code === code).length;
    const duplicates = byCode('duplicate_row_key');
    const reviewIds = [...rowReviews, ...(reviewItemId ? [reviewItemId] : [])];
    const opened = input.importStartedAt
      ? await reviewsOpenedSince(market.reviews.col, reviewIds, input.importStartedAt)
      : [...new Set(reviewIds)];
    for (const id of opened) trace.add('reviewIds', id);
    return {
      outcomes,
      reviewItemId,
      report,
      importReport: {
        counts: {
          rows: input.rowCount,
          parsed: input.rowCount - byCode('malformed_row'),
          accepted,
          created: outcomes.registered,
          // A board file never changes an existing job source.
          updated: 0,
          unchanged: outcomes.unchanged,
          // Duplicates, and warning rows that had no board to import.
          ignored: duplicates + input.skippedCount,
          failed: input.errorCount - duplicates + outcomes.failed + decidedFailures,
          reviews: opened.length,
          warnings: input.warningCount,
        },
        trace: { ...trace.result(), reportArtifactId: report?.artifactId ?? null },
      },
    };
  },
});

/**
 * OPS-5 job URL import: after the board rows, start a listing refresh of every board a row
 * resolved to a company, so the posted jobs become canonical jobs now rather than at the next
 * scheduled refresh. Only when the run was started by a `jobs` import (`enabled`); a plain board
 * import keeps its schedule-only behaviour. Boards with no company (a claim given back, a review)
 * are not refreshed.
 */
export const refreshImportedBoards = defineCapability({
  type: 'market.refresh_imported_boards',
  version: 1,
  title: 'Refresh Imported Boards',
  description:
    'For a job URL import: starts one listing refresh per distinct board source that the import resolved to a company (keyed per run and source).',
  category: 'domain',
  inputSchema: z.object({
    enabled: z.boolean().default(false),
    fanout: z.object({ total: z.number().int(), outputs: z.array(z.unknown()) }).passthrough(),
  }),
  outputSchema: z.object({
    enabled: z.boolean(),
    boards: z.number().int(),
    started: z.number().int(),
    skipped: z.number().int(),
    runIds: z.array(z.string()),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Each refresh run carries the idempotency key job_urls:<runId>:<sourceId>; a retry returns the same runs.',
  },
  async execute(ctx, input) {
    if (!input.enabled) return { enabled: false, boards: 0, started: 0, skipped: 0, runIds: [] };
    const market = ctx.services.get(MARKET);
    const ids = new Set<string>();
    for (const o of input.fanout.outputs) {
      const r = o as { outcome?: string; sourceId?: string; companyId?: string } | null;
      if (r?.sourceId && r.companyId && (r.outcome === 'registered' || r.outcome === 'unchanged'))
        ids.add(r.sourceId);
    }
    const runIds: string[] = [];
    let skipped = 0;
    for (const id of ids) {
      try {
        const { runId } = await market.sources.runNow(
          id,
          SYSTEM_ACTOR,
          {},
          { idempotencyKey: `job_urls:${ctx.runId}:${id}` },
        );
        runIds.push(runId);
      } catch (err) {
        // A disabled or upload-only source is not refreshed; the import itself stays successful.
        skipped++;
        market.ctx.logger.warn({ sourceId: id, err }, 'job url import: board refresh not started');
      }
    }
    return { enabled: true, boards: ids.size, started: runIds.length, skipped, runIds };
  },
});
