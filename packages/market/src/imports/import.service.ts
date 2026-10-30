import type { Collection } from 'mongodb';
import { type Actor, AppError, newId, NotFoundError } from '@aptamind/contracts';
import { getCollection, validateDocument } from '@aptamind/db';
import type { MarketDomain } from '../market-domain';
import { ATS_BOARD_DIRECTORY_PROVIDER } from '../sources/providers/ats-board-directory';
import { COMPANY_DIRECTORY_PROVIDER } from '../sources/providers/company-directory';
import type { SourceDoc } from '../sources/source.schema';
import { uploadSnapshot } from '../sources/snapshot-upload';
import { type ImportCounts, importReportSchema, type ImportTraceIds } from './import-report';
import { type ImportDoc, importsCollection, type ImportStatus, type ImportType } from './import.schema';

/** The upload-only provider each file type imports through (`snapshot` takes any source). */
const TYPE_PROVIDER: Partial<Record<ImportType, string>> = {
  companies: COMPANY_DIRECTORY_PROVIDER,
  ats_boards: ATS_BOARD_DIRECTORY_PROVIDER,
};

/** Most UTF-16 units a stored file name may have (the record schema's limit). */
const FILE_NAME_MAX = 255;

/**
 * Trimmed, control and format characters removed (a bidi override such as U+202E can disguise
 * the extension), and lone surrogates and U+2028/U+2029 too (they break JSON and log lines),
 * cut at a whole code point within 255 UTF-16 units; empty → `upload`.
 */
export function cleanFileName(raw: string | undefined): string {
  const clean = (raw ?? '').replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, '').trim();
  let name = '';
  for (const ch of clean) {
    if (name.length + ch.length > FILE_NAME_MAX) break;
    name += ch;
  }
  return name.trim() || 'upload';
}

/**
 * Refuse a wrong target before anything is stored: `jobs` is not available yet, the source must
 * exist and be enabled, and its provider must match the type.
 * @throws AppError validation_failed (`not_supported`, `wrong_source_type`), not_found, invalid_state
 */
export async function checkImportTarget(
  market: MarketDomain,
  type: ImportType,
  sourceId: string,
): Promise<SourceDoc> {
  if (type === 'jobs')
    throw new AppError('validation_failed', 'Job imports are not supported yet', {
      problems: [{ code: 'not_supported' }],
    });
  const source = await market.sources.get(sourceId);
  const provider = TYPE_PROVIDER[type];
  if (provider && source.provider !== provider)
    throw new AppError(
      'validation_failed',
      `Import type ${type} needs a source with provider ${provider}; source ${source._id} has provider ${source.provider}`,
      { problems: [{ code: 'wrong_source_type', expected: provider, actual: source.provider }] },
    );
  if (!source.enabled) throw new AppError('invalid_state', `Source ${source.key} is disabled`);
  return source;
}

/**
 * Upload a file as a snapshot of the source (the same checks and audit as the source upload),
 * start the source's workflow on it and record the import. A refused file throws before any
 * record exists. A run that cannot start is kept on the record as `error` (status `failed`).
 * @throws AppError from `checkImportTarget` and `uploadSnapshot`
 */
export async function createImport(
  market: MarketDomain,
  input: {
    type: ImportType;
    sourceId: string;
    fileName?: string;
    body: Uint8Array | string;
    contentType: string;
  },
  actor: Actor,
): Promise<ImportDoc> {
  const source = await checkImportTarget(market, input.type, input.sourceId);
  const snap = await uploadSnapshot(market, source._id, input.body, input.contentType, actor);
  let runId: string | null = null;
  let error: ImportDoc['error'];
  try {
    runId = (await market.sources.runNow(source._id, actor, { snapshotId: snap.snapshotId })).runId;
  } catch (err) {
    // The snapshot is stored either way; the record says why nothing runs (the operator retries).
    error = {
      code: err instanceof AppError ? err.code : 'internal',
      message: err instanceof AppError ? err.message : 'The import run could not be started',
    };
    market.ctx.logger.warn(
      { sourceId: source._id, snapshotId: snap.snapshotId, err },
      'import run not started',
    );
  }
  const doc = validateDocument(importsCollection, {
    _id: newId('imp'),
    type: input.type,
    fileName: cleanFileName(input.fileName),
    contentType: input.contentType,
    bytes: snap.bytes,
    contentHash: snap.sha256,
    artifactId: snap.artifactId,
    snapshotId: snap.snapshotId,
    snapshotUnchanged: snap.unchanged,
    sourceId: source._id,
    runId,
    createdBy: actor,
    createdAt: market.ctx.clock.now(),
    ...(error ? { error } : {}),
    schemaVersion: 1,
  });
  await getCollection(market.ctx.db, importsCollection).insertOne(doc);
  return doc;
}

// ------------------------------------------------------------------ read model

/** The run fields an import reads (structural: Market does not import the workflow engine). */
export interface ImportRunView {
  _id: string;
  state: string;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  output?: unknown;
  outputRef?: { artifactId: string };
}

export type ImportRunCollection = Collection<ImportRunView>;

type NullableCounts = { [K in keyof ImportCounts]: number | null };

const NO_COUNTS: NullableCounts = {
  rows: null,
  parsed: null,
  accepted: null,
  created: null,
  updated: null,
  unchanged: null,
  ignored: null,
  failed: null,
  reviews: null,
  warnings: null,
};

export interface ImportView extends Omit<ImportDoc, 'schemaVersion'> {
  source: { id: string; name: string; provider: string };
  status: ImportStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  counts: NullableCounts;
  trace: ImportTraceIds & {
    runId: string | null;
    snapshotId: string;
    artifactId: string;
    reportArtifactId: string | null;
  };
}

const TERMINAL: Record<string, ImportStatus> = { FAILED: 'failed', CANCELLED: 'cancelled' };

/** The import report in a completed run's output (inline or stored as an artifact). */
async function reportOf(market: MarketDomain, run: ImportRunView) {
  const output = run.outputRef ? await market.ctx.artifacts.readJson(run.outputRef) : run.output;
  const parsed = importReportSchema.safeParse((output as { importReport?: unknown } | null)?.importReport);
  return parsed.success ? parsed.data : null;
}

/** Status, counts and trace derived from the run (one batched run and source lookup per page). */
async function views(
  market: MarketDomain,
  runs: ImportRunCollection,
  docs: ImportDoc[],
): Promise<ImportView[]> {
  const runIds = docs.flatMap((d) => (d.runId ? [d.runId] : []));
  const sourceIds = [...new Set(docs.map((d) => d.sourceId))];
  const [runDocs, sourceDocs] = await Promise.all([
    runIds.length
      ? runs
          .find(
            { _id: { $in: runIds } },
            { projection: { state: 1, startedAt: 1, finishedAt: 1, output: 1, outputRef: 1 } },
          )
          .toArray()
      : [],
    market.sources.col.find({ _id: { $in: sourceIds } }, { projection: { name: 1, provider: 1 } }).toArray(),
  ]);
  const runById = new Map(runDocs.map((r) => [r._id, r as ImportRunView]));
  const sourceById = new Map(sourceDocs.map((s) => [s._id, s]));
  return Promise.all(
    docs.map(async ({ schemaVersion: _version, ...doc }) => {
      const run = doc.runId ? runById.get(doc.runId) : undefined;
      const source = sourceById.get(doc.sourceId);
      let status: ImportStatus;
      let counts = NO_COUNTS;
      let ids: ImportTraceIds & { reportArtifactId: string | null } = {
        reviewIds: [],
        companyIds: [],
        sourceIds: [],
        truncated: false,
        reportArtifactId: null,
      };
      if (!run) status = 'failed';
      else if (run.state === 'COMPLETED') {
        // A `snapshot` import runs the source's own workflow: it reports no counts.
        const report = doc.type === 'snapshot' ? null : await reportOf(market, run);
        if (report) {
          counts = report.counts;
          ids = report.trace;
        }
        status =
          report && (report.counts.failed > 0 || report.counts.reviews > 0)
            ? 'completed_with_issues'
            : 'completed';
      } else status = TERMINAL[run.state] ?? 'processing';
      return {
        ...doc,
        source: {
          id: doc.sourceId,
          name: source?.name ?? doc.sourceId,
          provider: source?.provider ?? 'unknown',
        },
        status,
        startedAt: run?.startedAt ?? null,
        finishedAt: run?.finishedAt ?? null,
        counts,
        trace: { runId: doc.runId, snapshotId: doc.snapshotId, artifactId: doc.artifactId, ...ids },
      };
    }),
  );
}

/** @throws NotFoundError for an unknown id */
export async function getImport(
  market: MarketDomain,
  runs: ImportRunCollection,
  id: string,
): Promise<ImportView> {
  const doc = await getCollection(market.ctx.db, importsCollection).findOne({ _id: id });
  if (!doc) throw new NotFoundError('Import', id);
  return (await views(market, runs, [doc]))[0]!;
}

/** A list row: the detail without `trace`. */
export type ImportSummary = Omit<ImportView, 'trace'>;
const summary = ({ trace: _trace, ...rest }: ImportView): ImportSummary => rest;

export interface ImportListQuery {
  type?: ImportType;
  status?: ImportStatus;
  sourceId?: string;
  cursor?: string;
  limit: number;
}

/** Records read per scan step when filtering by derived status; at most `STATUS_SCAN_MAX` per page. */
const STATUS_SCAN_BATCH = 200;
const STATUS_SCAN_MAX = 2000;

const encode = (doc: Pick<ImportDoc, '_id' | 'createdAt'>) =>
  Buffer.from(JSON.stringify({ t: doc.createdAt.toISOString(), id: doc._id })).toString('base64url');

function decode(cursor: string): { createdAt: Date; id: string } {
  try {
    const p = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown };
    const createdAt = new Date(String(p.t));
    if (typeof p.id === 'string' && !Number.isNaN(createdAt.getTime())) return { createdAt, id: p.id };
  } catch {
    // Falls through to the validation error below.
  }
  throw new AppError('validation_failed', 'Malformed cursor', { param: 'cursor' });
}

/**
 * Imports newest first (`createdAt`, `_id` descending), keyset-paginated. Status is derived, so a
 * status filter scans records in batches (each batch: one run lookup) and stops after
 * `STATUS_SCAN_MAX` records; `nextCursor` then continues the scan from where it stopped.
 */
export async function listImports(
  market: MarketDomain,
  runs: ImportRunCollection,
  q: ImportListQuery,
): Promise<{ items: ImportSummary[]; nextCursor: string | null }> {
  const col = getCollection(market.ctx.db, importsCollection);
  const base: Record<string, unknown> = {};
  if (q.type) base.type = q.type;
  if (q.sourceId) base.sourceId = q.sourceId;
  let after = q.cursor ? decode(q.cursor) : null;
  const page = (n: number) =>
    col
      .find({
        ...base,
        ...(after
          ? {
              $or: [
                { createdAt: { $lt: after.createdAt } },
                { createdAt: after.createdAt, _id: { $lt: after.id } },
              ],
            }
          : {}),
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(n)
      .toArray();

  if (!q.status) {
    const docs = await page(q.limit + 1);
    const more = docs.length > q.limit;
    const items = (await views(market, runs, docs.slice(0, q.limit))).map(summary);
    return { items, nextCursor: more ? encode(docs[q.limit - 1]!) : null };
  }
  const items: ImportSummary[] = [];
  let scanned = 0;
  while (scanned < STATUS_SCAN_MAX) {
    const docs = await page(STATUS_SCAN_BATCH);
    if (!docs.length) return { items, nextCursor: null };
    scanned += docs.length;
    for (const v of await views(market, runs, docs)) {
      after = { createdAt: v.createdAt, id: v._id };
      if (v.status !== q.status) continue;
      items.push(summary(v));
      if (items.length === q.limit) return { items, nextCursor: encode(v) };
    }
    if (docs.length < STATUS_SCAN_BATCH) return { items, nextCursor: null };
  }
  return { items, nextCursor: after ? encode({ _id: after.id, createdAt: after.createdAt }) : null };
}
