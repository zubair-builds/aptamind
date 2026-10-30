import { z } from 'zod';
import { type AnyCapability, defineCapability, RetryableError, TerminalError } from '@aptamind/workflow-sdk';
import { ProfessionalError } from '../api/errors';
import { idSchema } from '../contracts/ids';
import { EXTRACTION_SKIP_REASONS } from '../extraction/extraction.schema';
import { PROFESSIONAL } from '../professional-domain';
import { SNAPSHOT_VIA, SOURCE_KINDS } from '../sources/source.schema';

/**
 * Professional domain capabilities (`professional.*`), registered through the same contract as
 * generic ones. Inputs, outputs and configs carry opaque ids, enums and counts only (R-34,
 * enforced by `privacy/capability-io.test.ts`): generic run views persist and show them. Error
 * messages are fixed codes (the runtime persists `err.message`).
 */

/**
 * Data classes whose snapshots may be processed — an explicit allowlist, not the schema's
 * `DATA_CLASSES`, so adding a data class never silently makes it processable.
 */
export const PROCESSABLE_DATA_CLASSES: readonly string[] = ['synthetic', 'owner_consented'];

/** Whether snapshots of a subject with this data class may be processed (the allowlist is injectable for tests). */
export function isProcessableDataClass(
  dataClass: string,
  allowlist: readonly string[] = PROCESSABLE_DATA_CLASSES,
): boolean {
  return allowlist.includes(dataClass);
}

/**
 * Runs a capability body so that only fixed codes leave it (B-L3): the runtime persists and
 * logs `err.message`/stack, and Zod, S3 or MongoDB errors can quote values. Professional errors
 * become terminal with their code; anything else a retryable fixed-code error.
 */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TerminalError) throw err;
    if (err instanceof ProfessionalError)
      throw err.code === 'internal'
        ? new RetryableError('professional_internal')
        : new TerminalError(err.code);
    throw new RetryableError('professional_capability_error');
  }
}

const ingestInput = z.strictObject({
  subjectId: idSchema('subject'),
  sourceId: idSchema('source'),
  snapshotId: idSchema('snapshot'),
});

/** Load Snapshot: checks the snapshot, its source and subject before any extractor runs. */
export const loadSnapshot = defineCapability({
  type: 'professional.load_snapshot',
  version: 1,
  title: 'Load Professional snapshot',
  description:
    'Checks that the snapshot belongs to the source and subject, that the subject is active and consent permits processing; returns ids and enums only.',
  category: 'domain',
  inputSchema: ingestInput,
  outputSchema: z.strictObject({
    snapshotId: idSchema('snapshot'),
    via: z.enum(SNAPSHOT_VIA),
    sourceKind: z.enum(SOURCE_KINDS),
  }),
  configSchema: z.strictObject({}),
  execution: { retryable: true, idempotency: 'pure', sideEffects: false },
  execute: (ctx, input) =>
    guarded(async () => {
      const p = ctx.services.get(PROFESSIONAL);
      const snapshot = await p.snapshots.col.findOne({ _id: input.snapshotId });
      if (!snapshot) throw new TerminalError('snapshot_not_found');
      if (snapshot.sourceId !== input.sourceId || snapshot.subjectId !== input.subjectId)
        throw new TerminalError('snapshot_mismatch');
      const [source, subject] = await Promise.all([
        p.sources.get(input.sourceId),
        p.subjects.get(input.subjectId),
      ]);
      if (subject.status !== 'active') throw new TerminalError('subject_archived');
      // v0.1 processes synthetic and owner-consented data only.
      if (!isProcessableDataClass(subject.consent.dataClass)) throw new TerminalError('consent_required');
      return { snapshotId: snapshot._id, via: snapshot.via, sourceKind: source.kind };
    }),
});

/** Extract Structured: form fields → `stated` observations (no AI; documents skip until P2.1). */
export const extractStructured = defineCapability({
  type: 'professional.extract_structured',
  version: 1,
  title: 'Extract structured statements',
  description:
    'Deterministic structured extractor: turns a form snapshot into stated observations with full provenance; records other snapshots as skipped (unsupported_format).',
  category: 'domain',
  inputSchema: z.strictObject({ snapshotId: idSchema('snapshot') }),
  outputSchema: z.strictObject({
    extractionId: idSchema('extraction'),
    status: z.enum(['completed', 'skipped', 'failed']),
    observations: z.number().int().nonnegative(),
    skipReason: z.enum(EXTRACTION_SKIP_REASONS).optional(),
    replayed: z.boolean(),
  }),
  configSchema: z.strictObject({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Extraction id det(snapshot, extractor@version) is the replay marker; observations have deterministic ids and are inserted-if-absent with the terminal extraction and its event in one transaction.',
  },
  execute: (ctx, input) =>
    guarded(() => ctx.services.get(PROFESSIONAL).extractions.extractStructured(input.snapshotId, ctx.runId)),
});

export const professionalCapabilities: AnyCapability[] = [loadSnapshot, extractStructured];
