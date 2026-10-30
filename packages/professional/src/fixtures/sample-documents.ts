import { deterministicId, UNAUTHENTICATED_INTERNAL_OPERATOR } from '@aptamind/contracts';
import { observationId } from '../observations/payload';

/**
 * One valid, synthetic document per Professional collection (no real person's data). Used by
 * the collection unit tests and the server-side validation integration test until real flows
 * write these collections (P1.x).
 */
export function sampleDocuments(seed = 'persona-alpha') {
  const now = new Date('2026-09-29T12:00:00.000Z');
  const meta = { schemaVersion: 1, createdAt: now, updatedAt: now };
  const actor = { kind: UNAUTHENTICATED_INTERNAL_OPERATOR.kind, id: UNAUTHENTICATED_INTERNAL_OPERATOR.id };
  const subjectId = deterministicId('psub', seed);
  const sourceId = deterministicId('psrc', seed, 'cv');
  const sha = 'a'.repeat(64);
  const snapshotId = deterministicId('psnap', seed, 'snapshot');
  const extractionId = deterministicId('pext', snapshotId, 'cv_structured', 1);
  const skill = { label: 'TypeScript', concept: 'typescript', kind: 'skill', context: 'listed' };
  const targetSpec = {
    label: 'Data platform lead',
    fit: { roleFamilies: ['data_engineering'], seniority: { min: 'senior' } },
    viability: { geography: [{ scope: 'country', code: 'DE', mode: 'live_in' }], constraints: [] },
  };
  const artifact = {
    artifactId: deterministicId('art', sha),
    storageKey: `sha256/${sha}`,
    mimeType: 'text/plain',
    size: 42,
    sha256: sha,
    createdAt: now,
  };
  return {
    professional_subjects: {
      _id: subjectId,
      status: 'active',
      reference: 'op-ref-001',
      consent: {
        dataClass: 'synthetic',
        processingBasis: 'consent',
        aiProcessing: 'denied',
        recordedBy: actor,
        recordedAt: now,
      },
      sourceCount: 1,
      acquisitionCount: 1,
      rev: 0,
      createdBy: actor,
      ...meta,
    },
    professional_sources: {
      _id: sourceId,
      subjectId,
      kind: 'cv',
      authorship: 'subject',
      acquisition: 'upload',
      policy: { hostScope: [], maxPages: 50 },
      ownership: { state: 'intrinsic' },
      status: 'active',
      stats: { snapshots: 1, observations: 1, lastAcquiredAt: now },
      health: { state: 'ok', consecutiveFailures: 0 },
      createdBy: actor,
      ...meta,
    },
    professional_snapshots: {
      _id: snapshotId,
      subjectId,
      sourceId,
      artifact,
      contentHash: sha,
      mimeType: 'text/plain',
      via: 'upload',
      sourceAsOf: now,
      sourceAsOfKind: 'acquired',
      acquisitions: 1,
      firstAcquiredAt: now,
      lastAcquiredAt: now,
      ...meta,
    },
    professional_acquisitions: {
      _id: deterministicId('pacq', sourceId, 'idem', 'fixture-key'),
      subjectId,
      sourceId,
      snapshotId,
      via: 'upload',
      bindingHash: 'b'.repeat(64),
      keyed: true,
      createdBy: actor,
      ...meta,
    },
    professional_extractions: {
      _id: extractionId,
      subjectId,
      sourceId,
      snapshotId,
      extractor: { name: 'cv_structured', version: 1, kind: 'deterministic' },
      status: 'completed',
      current: true,
      sections: [{ id: 's1', class: 'experience', start: 0, end: 40, hash: 'b'.repeat(64) }],
      counts: { observations: 1, dropped: 0, protectedDropped: 0, unverifiedSpans: 0 },
      completedAt: now,
      ...meta,
    },
    professional_observations: {
      _id: observationId({
        snapshotId,
        extractor: { name: 'cv_structured', version: 1 },
        claimType: 'skill',
        locator: 's1:0-10',
        payload: skill,
      }),
      subjectId,
      sourceId,
      snapshotId,
      extractionId,
      claimType: 'skill',
      payload: skill,
      mode: 'extracted',
      extractor: { kind: 'deterministic', name: 'cv_structured', version: 1 },
      evidence: {
        artifactId: artifact.artifactId,
        locator: 's1:0-10',
        quote: 'TypeScript',
        spanVerified: true,
      },
      confidence: { level: 'high', reasons: ['verified_span'] },
      warnings: [],
      sourceAsOf: now,
      status: 'current',
      resolution: { state: 'pending' },
      ...meta,
    },
    professional_events: {
      _id: deterministicId('pevt', 'run_1', 'subject', 0),
      subjectId,
      entity: { kind: 'subject', id: subjectId },
      type: 'subject.created',
      to: 'active',
      reason: 'operator_created',
      actor,
      at: now,
      ...meta,
    },
    professional_review_items: {
      _id: deterministicId('prvw', 'parser_failure', snapshotId),
      subjectId,
      type: 'parser_failure',
      dedupeKey: `parser_failure:${snapshotId}`,
      status: 'open',
      entity: { kind: 'snapshot', id: snapshotId },
      reasonCode: 'pdf_malformed',
      allowedActions: ['retry', 'dismiss'],
      priority: 10,
      occurrences: 1,
      ...meta,
    },
    professional_career_targets: {
      _id: deterministicId('ptgt', subjectId, 'idem', 'target-1'),
      subjectId,
      status: 'active',
      priority: 1,
      spec: targetSpec,
      origin: 'stated',
      basis: 'confirmed',
      rev: 0,
      version: 1,
      createRequestHash: sha,
      createdBy: actor,
      ...meta,
    },
    professional_career_target_versions: {
      _id: deterministicId('ptgv', deterministicId('ptgt', subjectId, 'idem', 'target-1'), 1),
      subjectId,
      targetId: deterministicId('ptgt', subjectId, 'idem', 'target-1'),
      version: 1,
      status: 'active',
      priority: 1,
      spec: targetSpec,
      origin: 'stated',
      basis: 'confirmed',
      cause: { kind: 'created', reason: 'operator_stated' },
      actor,
      attestation: { mode: 'operator_relayed' },
      ...meta,
    },
  } as const;
}
