import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import { z, ZodError } from 'zod';
import { type Actor, canonicalJson } from '@aptamind/contracts';
import { getCollection } from '@aptamind/db';
import { type Logger, metrics } from '@aptamind/observability';
import { ProfessionalError } from '../api/errors';
import type { ProfessionalContext, RunLauncher, RunStateReader } from '../context';
import { idSchema } from '../contracts/ids';
import { ExtractionService } from '../extraction/extraction.service';
import { type ExtractionDoc, extractionsCollection } from '../extraction/extraction.schema';
import { safeError } from '../privacy/logger';
import { STRUCTURED_EXTRACTOR } from '../structured/extractor';
import { FORM_SOURCE_KIND, structuredFormSchema } from '../structured/forms';
import type { SubjectService } from '../subjects/subject.service';
import { PROFESSIONAL_INGEST_WORKFLOW } from '../workflows/keys';
import type { SnapshotService, UploadInput } from './snapshot.service';
import type { SnapshotDoc } from './source.schema';
import type { SourceService } from './source.service';

/** `POST /api/professional/subjects/:id/statements` body: a form for one structured source. */
export const statementsRequestSchema = z.strictObject({
  sourceId: idSchema('source'),
  form: structuredFormSchema,
});

export const PROCESSING_STATES = ['pending', 'launched', 'processed', 'skipped', 'failed'] as const;

/**
 * `failed` reasons that are the run's fault, not the data's: the run ended FAILED/CANCELLED
 * (`run_failed`), its run document is gone (`run_missing`), or it COMPLETED without recording an
 * extraction (`run_ended_without_extraction`). Only these are retried by a re-acquisition.
 */
export const RUN_FAILURE_REASONS = ['run_failed', 'run_missing', 'run_ended_without_extraction'] as const;

/**
 * A snapshot's processing outcome, derived from the ledger (supervisor ruling, P1.3) — never
 * stored, never read from generic run views:
 * - `processed` / `skipped` (with its reason): the structured extraction is terminal;
 * - `failed`: the extraction failed (`reason` = its code; `final: true` for the current
 *   extractor — reprocessing would replay the same result, so it is refused with 409
 *   `extraction_failed_final`), or the run failed without one (`RUN_FAILURE_REASONS`);
 * - `launched`: the latest run is in flight; `pending`: no run was ever started.
 * An extraction by an older extractor version (after a version bump) keeps its outcome with
 * `olderExtractorVersion`: such a snapshot is not re-launched automatically — reprocess runs the
 * current extractor.
 */
export interface SnapshotProcessing {
  state: (typeof PROCESSING_STATES)[number];
  reason?: string;
  /** `failed` only: `true` when retrying cannot help (a failed extraction of the current extractor). */
  final?: boolean;
  /** The version of the extractor that produced the outcome, when older than the current one. */
  olderExtractorVersion?: number;
  /** The snapshot's latest ingest run. */
  runId?: string;
}

/** Whether a re-acquisition (or the initial acquisition) launches a run for this status. */
export function needsRun(p: SnapshotProcessing): boolean {
  return (
    p.state === 'pending' ||
    (p.state === 'failed' && (RUN_FAILURE_REASONS as readonly string[]).includes(p.reason ?? ''))
  );
}

export type SnapshotWithProcessing = SnapshotDoc & { processing: SnapshotProcessing };

export interface AcquiredSnapshot {
  snapshot: SnapshotWithProcessing;
  created: boolean;
  /** The snapshot's latest ingest run; `null` while unprocessed (launch failed — reprocess it). */
  runId: string | null;
}

const FAILED_RUN_STATES = new Set(['FAILED', 'CANCELLED']);
const TERMINAL_RUN_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/**
 * Acquisition → ingest (P1.3). Each snapshot gets one initial ingest run
 * (`professional.source.ingest`, run idempotency key per snapshot): the acquisition that creates
 * the snapshot launches it; a re-acquisition, replay or later upload of the same bytes returns the
 * snapshot's latest run (identical bytes extract identically) and launches only when the snapshot
 * is unprocessed — never started (`pending`) or its run `failed` (then a retry run keyed on the
 * failed run, so concurrent re-acquisitions start one). The snapshot commits first
 * (`ingest.state: pending`); a failed launch or crash in between leaves it `pending` (visible,
 * never lost). `reprocess` always starts a new run; the extraction ledger makes it write nothing
 * for work already done. `ingest.runId` is state — the latest run — and only moves to a newer run.
 */
export class IngestService {
  private readonly extractions: Collection<ExtractionDoc>;

  constructor(
    private readonly ctx: ProfessionalContext,
    private readonly subjects: SubjectService,
    private readonly sources: SourceService,
    private readonly snapshots: SnapshotService,
    private readonly log: Logger,
    private readonly launcher?: RunLauncher,
    private readonly runs?: RunStateReader,
  ) {
    this.extractions = getCollection(ctx.db, extractionsCollection);
  }

  async upload(
    sourceId: string,
    input: UploadInput,
    actor: Actor,
    idempotencyKey?: string,
  ): Promise<AcquiredSnapshot> {
    const r = await this.snapshots.upload(sourceId, input, actor, idempotencyKey);
    return { created: r.created, ...(await this.ensureLaunched(r.snapshot, actor)) };
  }

  /** Stores a structured form of the subject's `manual_input` / `questionnaire` source and ingests it. */
  async submitStatements(
    subjectId: string,
    body: unknown,
    actor: Actor,
    idempotencyKey?: string,
  ): Promise<AcquiredSnapshot> {
    let form = 'unknown';
    try {
      await this.subjects.get(subjectId); // 404 for an unknown subject, before the body
      const req = statementsRequestSchema.parse(body);
      form = req.form.form;
      const source = await this.sources.get(req.sourceId);
      if (source.subjectId !== subjectId)
        throw new ProfessionalError('validation_failed', 'Source belongs to another subject', {
          field: 'sourceId',
        });
      if (source.kind !== FORM_SOURCE_KIND[req.form.form])
        throw new ProfessionalError('validation_failed', 'Form does not match the source kind', {
          field: 'sourceId',
        });
      // Stored as submitted (validated, canonical key order), so evidence quotes are verbatim.
      const raw = (body as { form: unknown }).form;
      const r = await this.snapshots.submitForm(source, canonicalJson(raw), actor, idempotencyKey);
      const out = { created: r.created, ...(await this.ensureLaunched(r.snapshot, actor)) };
      countStatements(out.created ? 'created' : 'reacquired', form);
      return out;
    } catch (err) {
      countStatements(
        err instanceof ProfessionalError ? err.code : err instanceof ZodError ? 'validation_failed' : 'error',
        form,
      );
      throw err;
    }
  }

  /** Starts a new ingest run for a stored snapshot (operator action; e.g. an unprocessed one). */
  async reprocess(
    snapshotId: string,
    actor: Actor,
    idempotencyKey?: string,
  ): Promise<{ snapshot: SnapshotWithProcessing; runId: string }> {
    const snapshot = await this.snapshots.get(snapshotId);
    const subject = await this.subjects.get(snapshot.subjectId);
    if (subject.status !== 'active')
      throw new ProfessionalError('subject_archived', 'Subject is archived', { id: subject._id });
    // A failed extraction of the current extractor is final: a new run would replay it.
    const [current] = await this.processingOf([snapshot]);
    if (current!.final)
      throw new ProfessionalError('extraction_failed_final', 'Extraction failed; reprocessing replays it', {
        id: snapshotId,
        reason: current!.reason ?? 'extraction_failed',
      });
    const key = `${PROFESSIONAL_INGEST_WORKFLOW}:${snapshotId}:reprocess:${idempotencyKey ?? randomUUID()}`;
    const runId = await this.launch(snapshot, actor, key);
    return { snapshot: await this.detail(snapshotId), runId };
  }

  /** A snapshot with its derived processing status. */
  async detail(snapshotId: string): Promise<SnapshotWithProcessing> {
    const [s] = await this.withProcessing([await this.snapshots.get(snapshotId)]);
    return s!;
  }

  /** Attaches the derived processing status (one query for extractions, one for run states). */
  async withProcessing(snapshots: readonly SnapshotDoc[]): Promise<SnapshotWithProcessing[]> {
    const processing = await this.processingOf(snapshots);
    return snapshots.map((s, i) => ({ ...s, processing: processing[i]! }));
  }

  /** Snapshots of the subject that need an operator: never started (`pending`) or `failed`. */
  async unprocessedCount(subjectId: string): Promise<number> {
    const snaps = await this.snapshots.col
      .find({ subjectId }, { projection: { _id: 1, ingest: 1 } })
      .toArray();
    const states = await this.processingOf(snaps);
    return states.filter((p) => p.state === 'pending' || p.state === 'failed').length;
  }

  private async processingOf(
    snapshots: readonly Pick<SnapshotDoc, '_id' | 'ingest'>[],
  ): Promise<SnapshotProcessing[]> {
    if (!snapshots.length) return [];
    const bySnapshot = await this.latestExtractions(snapshots.map((s) => s._id));
    const runIds = snapshots
      .filter((s) => s.ingest?.runId && !bySnapshot.has(s._id))
      .map((s) => s.ingest!.runId!);
    const states = runIds.length && this.runs ? await this.runs.states(runIds) : undefined;
    // A run that ended between the two reads may have recorded its extraction: read those again.
    const ended = snapshots.filter(
      (s) =>
        !bySnapshot.has(s._id) && s.ingest?.runId && TERMINAL_RUN_STATES.has(states?.[s.ingest.runId] ?? ''),
    );
    if (ended.length)
      for (const [id, e] of await this.latestExtractions(ended.map((s) => s._id))) bySnapshot.set(id, e);
    return snapshots.map((s) =>
      deriveProcessing(s, bySnapshot.get(s._id), states, STRUCTURED_EXTRACTOR.version),
    );
  }

  /** Each snapshot's structured extraction of the highest extractor version (current or older). */
  private async latestExtractions(snapshotIds: readonly string[]): Promise<Map<string, ExtractionDoc>> {
    const ids = snapshotIds.flatMap((id) =>
      Array.from({ length: STRUCTURED_EXTRACTOR.version }, (_, v) =>
        ExtractionService.structuredExtractionId(id, v + 1),
      ),
    );
    const found = await this.extractions.find({ _id: { $in: ids } }).toArray();
    const out = new Map<string, ExtractionDoc>();
    for (const e of found) {
      const seen = out.get(e.snapshotId);
      if (!seen || seen.extractor.version < e.extractor.version) out.set(e.snapshotId, e);
    }
    return out;
  }

  private async ensureLaunched(
    snapshot: SnapshotDoc,
    actor: Actor,
  ): Promise<{ snapshot: SnapshotWithProcessing; runId: string | null }> {
    const [current] = await this.withProcessing([snapshot]);
    const { state, runId } = current!.processing;
    if (!needsRun(current!.processing)) return { snapshot: current!, runId: runId ?? null };
    const subject = await this.subjects.get(snapshot.subjectId);
    if (subject.status !== 'active') return { snapshot: current!, runId: runId ?? null };
    // Initial run keyed per snapshot; after a failed run, a retry keyed on that run.
    const key =
      state === 'failed' && runId
        ? `${PROFESSIONAL_INGEST_WORKFLOW}:${snapshot._id}:after:${runId}`
        : `${PROFESSIONAL_INGEST_WORKFLOW}:${snapshot._id}`;
    try {
      await this.launch(snapshot, actor, key);
      const latest = await this.detail(snapshot._id);
      return { snapshot: latest, runId: latest.ingest?.runId ?? null };
    } catch (err) {
      // The snapshot is committed; it stays unprocessed until reprocessed.
      this.log.error({ err: safeError(err), snapshotId: snapshot._id }, 'professional ingest launch failed');
      return { snapshot: current!, runId: runId ?? null };
    }
  }

  private async launch(snapshot: SnapshotDoc, actor: Actor, idempotencyKey: string): Promise<string> {
    if (!this.launcher) throw new ProfessionalError('internal', 'No run launcher configured');
    const run = await this.launcher.startRun({
      workflowKey: PROFESSIONAL_INGEST_WORKFLOW,
      input: { subjectId: snapshot.subjectId, sourceId: snapshot.sourceId, snapshotId: snapshot._id },
      labels: { subjectId: snapshot.subjectId, sourceId: snapshot.sourceId },
      trigger: { kind: 'api', actor: { kind: actor.kind, id: actor.id } },
      idempotencyKey,
    });
    // An idempotency key that another caller used for a different run must not be adopted.
    if (run.workflowKey !== PROFESSIONAL_INGEST_WORKFLOW || run.input?.snapshotId !== snapshot._id)
      throw new ProfessionalError('conflict', 'Ingest run does not belong to this snapshot', {
        id: snapshot._id,
      });
    const now = this.ctx.clock.now();
    // `ingest.runId` only moves to a newer run (run ids are time-ordered ULIDs), so a concurrent
    // initial launch and reprocess never leave the older run recorded.
    await this.snapshots.col.updateOne(
      {
        _id: snapshot._id,
        $or: [{ 'ingest.runId': { $exists: false } }, { 'ingest.runId': { $lt: run._id } }],
      },
      {
        $set: {
          ingest: {
            state: 'launched',
            runId: run._id,
            requestedAt: snapshot.ingest?.requestedAt ?? now,
            launchedAt: now,
          },
          lastRunId: run._id,
          updatedAt: now,
        },
      },
    );
    return run._id;
  }
}

/**
 * Derives a snapshot's processing status (pure). `runStates` is `undefined` when no run-state
 * reader is configured (then a missing run cannot be told from an unknown one).
 */
export function deriveProcessing(
  s: Pick<SnapshotDoc, 'ingest'>,
  extraction: Pick<ExtractionDoc, 'status' | 'skipReason' | 'error' | 'extractor'> | undefined,
  runStates: Readonly<Record<string, string>> | undefined,
  currentExtractorVersion: number,
): SnapshotProcessing {
  const runId = s.ingest?.runId;
  const run = runId ? { runId } : {};
  if (extraction) {
    const older =
      extraction.extractor.version < currentExtractorVersion
        ? { olderExtractorVersion: extraction.extractor.version }
        : {};
    if (extraction.status === 'completed') return { state: 'processed', ...older, ...run };
    if (extraction.status === 'skipped')
      return {
        state: 'skipped',
        ...(extraction.skipReason ? { reason: extraction.skipReason } : {}),
        ...older,
        ...run,
      };
    if (extraction.status === 'failed')
      return {
        state: 'failed',
        reason: extraction.error?.code ?? 'extraction_failed',
        ...(older.olderExtractorVersion ? older : { final: true }),
        ...run,
      };
  }
  if (s.ingest?.state !== 'launched' || !runId) return { state: 'pending' };
  if (!runStates) return { state: 'launched', ...run };
  const runState = runStates[runId];
  if (runState === undefined) return { state: 'failed', reason: 'run_missing', ...run };
  if (FAILED_RUN_STATES.has(runState)) return { state: 'failed', reason: 'run_failed', ...run };
  if (runState === 'COMPLETED') return { state: 'failed', reason: 'run_ended_without_extraction', ...run };
  return { state: 'launched', ...run };
}

/** `professional_statements_total{outcome, form}`: enum labels only. */
function countStatements(outcome: string, form: string): void {
  metrics.inc('professional_statements_total', { outcome, form });
}
