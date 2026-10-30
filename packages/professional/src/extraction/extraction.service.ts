import type { Collection } from 'mongodb';
import { ZodError } from 'zod';
import { deterministicId, SYSTEM_ACTOR } from '@aptamind/contracts';
import { getCollection, validateDocument, withTransaction } from '@aptamind/db';
import { confidence } from '@aptamind/provenance';
import { metrics } from '@aptamind/observability';
import { notFound, ProfessionalError } from '../api/errors';
import type { ProfessionalContext } from '../context';
import type { EventStore } from '../events/event.store';
import {
  OBSERVATION_SCHEMA_VERSION,
  type ObservationDoc,
  observationsCollection,
} from '../observations/observation.schema';
import { observationId } from '../observations/payload';
import { type SnapshotDoc, snapshotsCollection } from '../sources/source.schema';
import { atPointer, extractStatements, fieldQuote, STRUCTURED_EXTRACTOR } from '../structured/extractor';
import { type SubjectDoc, subjectsCollection } from '../subjects/subject.schema';
import { EXTRACTION_SCHEMA_VERSION, type ExtractionDoc, extractionsCollection } from './extraction.schema';

/** What an extractor run reports to the workflow: ids, a status and counts only (R-34). */
export interface ExtractionOutcome {
  extractionId: string;
  status: 'completed' | 'skipped' | 'failed';
  observations: number;
  skipReason?: ExtractionDoc['skipReason'];
  /** `true` when a terminal extraction already existed (a replay wrote nothing). */
  replayed: boolean;
}

/**
 * The extraction ledger (R-6, R-10): one extraction per `(snapshot, extractor@version)`,
 * `det(snapshotId, name, version)`. A terminal extraction (`completed`, `skipped`, `failed`) is
 * the replay marker: re-running the extractor on the same snapshot returns it and writes
 * nothing. The observations, the terminal extraction and its event commit in one transaction,
 * so a crash mid-way leaves nothing and the rerun starts clean (P1.3 extracts synchronously; no
 * `running` state is written).
 */
export class ExtractionService {
  readonly col: Collection<ExtractionDoc>;
  readonly observations: Collection<ObservationDoc>;
  private readonly snapshots: Collection<SnapshotDoc>;
  private readonly subjects: Collection<SubjectDoc>;

  constructor(
    private readonly ctx: ProfessionalContext,
    private readonly events: EventStore,
  ) {
    this.col = getCollection(ctx.db, extractionsCollection);
    this.observations = getCollection(ctx.db, observationsCollection);
    this.snapshots = getCollection(ctx.db, snapshotsCollection);
    this.subjects = getCollection(ctx.db, subjectsCollection);
  }

  /** `det(snapshotId, structured_form, version)`; `version` defaults to the current extractor. */
  static structuredExtractionId(snapshotId: string, version: number = STRUCTURED_EXTRACTOR.version): string {
    return deterministicId('pext', snapshotId, STRUCTURED_EXTRACTOR.name, version);
  }

  /**
   * Runs the structured extractor on a snapshot. Form snapshots become `stated` observations
   * (evidence: the form artifact, the field's JSON pointer, the field as stored,
   * `spanVerified: true` by construction — N5). Other snapshots are recorded as `skipped`
   * (`unsupported_format`) until their extractor exists (documents: P2.1).
   */
  async extractStructured(snapshotId: string, runId?: string): Promise<ExtractionOutcome> {
    const _id = ExtractionService.structuredExtractionId(snapshotId);
    const existing = await this.col.findOne({ _id });
    if (existing) return outcomeOf(existing, true);
    const snapshot = await this.snapshots.findOne({ _id: snapshotId });
    if (!snapshot) throw notFound('snapshot', snapshotId);
    const now = this.ctx.clock.now();
    const base = {
      _id,
      subjectId: snapshot.subjectId,
      sourceId: snapshot.sourceId,
      snapshotId,
      extractor: { ...STRUCTURED_EXTRACTOR },
      current: true,
      sections: [],
      ...(runId ? { runId } : {}),
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    const zero = { observations: 0, dropped: 0, protectedDropped: 0, unverifiedSpans: 0 };

    let docs: ObservationDoc[] = [];
    let extraction: ExtractionDoc;
    if (snapshot.via !== 'form' || snapshot.mimeType !== 'application/json') {
      extraction = validateDocument(extractionsCollection, {
        ...base,
        status: 'skipped',
        skipReason: 'unsupported_format',
        counts: zero,
        completedAt: now,
      });
    } else {
      try {
        const stored = JSON.parse(
          new TextDecoder().decode(await this.ctx.artifacts.readBytes(snapshot.artifact)),
        );
        docs = extractStatements(stored).map((s) =>
          validateDocument(observationsCollection, {
            _id: observationId({ snapshotId, extractor: STRUCTURED_EXTRACTOR, ...s }),
            subjectId: snapshot.subjectId,
            sourceId: snapshot.sourceId,
            snapshotId,
            extractionId: _id,
            claimType: s.claimType,
            payload: s.payload,
            mode: 'stated',
            extractor: { ...STRUCTURED_EXTRACTOR },
            evidence: {
              artifactId: snapshot.artifact.artifactId,
              locator: s.locator,
              ...(s.quote !== undefined ? { quote: s.quote } : {}),
              // Compared, not assumed: the quote must equal the stored field (N5); no quote → false.
              spanVerified: s.quote !== undefined && fieldQuote(atPointer(stored, s.locator)) === s.quote,
            },
            confidence: confidence('high', 'subject_stated_form'),
            warnings: [],
            sourceAsOf: snapshot.sourceAsOf,
            status: 'current',
            resolution: { state: 'pending' },
            ...(runId ? { runId } : {}),
            schemaVersion: OBSERVATION_SCHEMA_VERSION,
            createdAt: now,
            updatedAt: now,
          }),
        );
        extraction = validateDocument(extractionsCollection, {
          ...base,
          status: 'completed',
          counts: { ...zero, observations: docs.length },
          completedAt: now,
        });
      } catch (err) {
        // A stored form that no longer parses (e.g. a schema change): recorded, never thrown on.
        if (!(err instanceof ZodError) && !(err instanceof SyntaxError)) throw err;
        extraction = validateDocument(extractionsCollection, {
          ...base,
          status: 'failed',
          counts: zero,
          error: { code: 'invalid_stored_form' },
          completedAt: now,
        });
      }
    }

    const outcome = await withTransaction(this.ctx.db.client, async (session) => {
      // Fence: the subject is still active (archive / erasure), and the write conflicts with a
      // concurrent archive like acquisitions do.
      const fenced = await this.subjects.updateOne(
        { _id: snapshot.subjectId, status: 'active' },
        { $inc: { extractionCount: 1 } },
        { session },
      );
      if (!fenced.matchedCount)
        throw new ProfessionalError('subject_archived', 'Subject is archived', { id: snapshot.subjectId });
      // A concurrent run of the same extraction commits first: its result is the replay.
      const inserted = await this.col.updateOne(
        { _id },
        { $setOnInsert: extraction },
        { upsert: true, session },
      );
      if (!inserted.upsertedCount) {
        const winner = await this.col.findOne({ _id }, { session });
        // The replay must not count: abort the fence write by leaving through an error path.
        if (winner) throw new ReplayOf(outcomeOf(winner, true));
      }
      for (const doc of docs)
        await this.observations.updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true, session });
      await this.events.append(
        `${_id}:terminal`,
        [
          {
            subjectId: snapshot.subjectId,
            entity: { kind: 'extraction', id: _id },
            type: `extraction.${extraction.status}`,
            to: extraction.status,
            reason: extraction.skipReason ?? extraction.error?.code ?? 'structured_form',
            ...(runId ? { runId } : {}),
          },
        ],
        SYSTEM_ACTOR,
        session,
      );
      return outcomeOf(extraction, false);
    }).catch((err) => {
      if (err instanceof ReplayOf) return err.outcome;
      throw err;
    });
    metrics.inc('professional_extractions_total', {
      extractor: STRUCTURED_EXTRACTOR.name,
      status: outcome.replayed ? 'replayed' : outcome.status,
    });
    return outcome;
  }
}

/** Leaves the transaction without committing (a concurrent run already recorded the result). */
class ReplayOf extends Error {
  constructor(readonly outcome: ExtractionOutcome) {
    super('extraction_replay');
  }
}

function outcomeOf(e: ExtractionDoc, replayed: boolean): ExtractionOutcome {
  return {
    extractionId: e._id,
    status: terminal(e.status),
    observations: e.counts.observations,
    ...(e.skipReason ? { skipReason: e.skipReason } : {}),
    replayed,
  };
}

/** P1.3 never writes `running`; seeing one is an invariant violation, not a failure outcome. */
function terminal(status: ExtractionDoc['status']): ExtractionOutcome['status'] {
  if (status === 'running') throw new ProfessionalError('internal', 'Extraction is not terminal');
  return status;
}
