import type { Db } from 'mongodb';
import { createServiceToken } from '@aptamind/workflow-sdk';
import type { Logger } from '@aptamind/observability';
import {
  hasProfessionalArtifactLabel,
  isProfessionalWorkflowKey,
  professionalReferencedArtifactIds,
  professionalReferencesArtifact,
} from './privacy/artifacts';
import type { ProfessionalContext, RunLauncher, RunStateReader, WorkflowResumer } from './context';
import { EventStore } from './events/event.store';
import { ensureVersionedCollections } from './schema-versions';
import { professionalLogger } from './privacy/logger';
import { ExtractionService } from './extraction/extraction.service';
import { ObservationService } from './observations/observation.service';
import { IngestService } from './sources/ingest.service';
import { SnapshotService } from './sources/snapshot.service';
import { SourceService } from './sources/source.service';
import { type SubjectOverview, subjectOverview } from './subjects/subject-overview';
import { SubjectService } from './subjects/subject.service';
import { TargetService } from './targets/target.service';

export interface ProfessionalDomainOptions {
  launcher?: RunLauncher;
  resumer?: WorkflowResumer;
  runs?: RunStateReader;
}

/**
 * The Professional domain facade: owns what is true about a professional (the subject), what
 * supports it, what the subject confirmed and which career directions they target. Workflows
 * reach it through `professional.*` capabilities (via the `PROFESSIONAL` service token); the
 * API calls into it directly. It depends on the generic runtime only through the narrow
 * `RunLauncher` / `WorkflowResumer` ports and never imports another domain.
 *
 * Services are added by the milestones that introduce them (subjects and sources in P1.1, career
 * targets in P5.1, …).
 */
export class ProfessionalDomain {
  readonly launcher?: RunLauncher;
  readonly resumer?: WorkflowResumer;
  /** Redacting child logger (R-32); Professional code logs through this only. */
  readonly logger: Logger;
  readonly events: EventStore;
  readonly subjects: SubjectService;
  readonly sources: SourceService;
  readonly snapshots: SnapshotService;
  readonly extractions: ExtractionService;
  readonly observations: ObservationService;
  /** Acquisition → ingest run (uploads, statements, reprocess). */
  readonly ingest: IngestService;
  readonly targets: TargetService;

  constructor(
    readonly ctx: ProfessionalContext,
    opts: ProfessionalDomainOptions = {},
  ) {
    this.launcher = opts.launcher;
    this.resumer = opts.resumer;
    this.logger = professionalLogger(ctx.logger);
    this.events = new EventStore(ctx);
    this.subjects = new SubjectService(ctx, this.events);
    this.sources = new SourceService(ctx, this.subjects, this.events);
    this.snapshots = new SnapshotService(ctx, this.subjects, this.sources, this.events);
    this.extractions = new ExtractionService(ctx, this.events);
    this.observations = new ObservationService(ctx, this.subjects);
    this.ingest = new IngestService(
      ctx,
      this.subjects,
      this.sources,
      this.snapshots,
      this.logger,
      opts.launcher,
      opts.runs,
    );
    this.targets = new TargetService(ctx, this.subjects, this.events);
  }

  /** Subject overview: the subject, counts per area and recent events. */
  overview(subjectId: string): Promise<SubjectOverview> {
    return subjectOverview(this.ctx.db, this.subjects, this.events, subjectId, (id) =>
      this.ingest.unprocessedCount(id),
    );
  }

  /**
   * Whether an artifact is Professional-owned and must never be served by generic routes
   * (FE-P6): stored with the Professional label, written by the runtime for a Professional
   * workflow, or referenced by a Professional document. Rejects (fails closed) on a read error.
   */
  async ownsArtifact(artifact: {
    _id: string;
    context?: { workflowKey?: string; labels?: Record<string, string> };
  }): Promise<boolean> {
    if (hasProfessionalArtifactLabel(artifact.context?.labels)) return true;
    if (isProfessionalWorkflowKey(artifact.context?.workflowKey)) return true;
    return professionalReferencesArtifact(this.ctx.db, artifact._id);
  }

  /** Whether a workflow is Professional (its runs and their artifacts are private; FE-P6). */
  ownsWorkflow(workflowKey: string): boolean {
    return isProfessionalWorkflowKey(workflowKey);
  }

  /** Batch form of the reference check: which of these artifact ids Professional documents use. */
  referencedArtifactIds(artifactIds: readonly string[]): Promise<Set<string>> {
    return professionalReferencedArtifactIds(this.ctx.db, artifactIds);
  }

  /** Idempotent: collections, validators and indexes. */
  async ensureReady(): Promise<void> {
    await ensureProfessionalCollections(this.ctx.db, (msg, data) => this.logger.warn(data, msg));
  }
}

/** Idempotently create the Professional collections, apply validators and create indexes. */
export async function ensureProfessionalCollections(
  db: Db,
  warn?: (msg: string, data: Record<string, unknown>) => void,
): Promise<void> {
  // Versioned: skips definitions a newer release applied (§15).
  await ensureVersionedCollections(db, undefined, undefined, warn);
}

/** Service token through which `professional.*` capabilities reach the domain. */
export const PROFESSIONAL = createServiceToken<ProfessionalDomain>('professional.domain');

export function createProfessionalDomain(
  ctx: ProfessionalContext,
  opts: ProfessionalDomainOptions = {},
): ProfessionalDomain {
  return new ProfessionalDomain(ctx, opts);
}
