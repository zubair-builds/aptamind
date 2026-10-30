import type { Db } from 'mongodb';
import { extractionsCollection } from '../extraction/extraction.schema';
import { snapshotsCollection } from '../sources/source.schema';

/**
 * Professional artifacts are private (R-4): they are served only through Professional routes
 * that check the owning subject, never through the generic `/api/artifacts/:id(/content)`
 * routes (FE-P6). An artifact is Professional-owned when
 *
 * - it was stored with the Professional context label (`{ domain: 'professional' }`, set on every
 *   Professional `ArtifactStore.put`), or
 * - the workflow runtime wrote it for a Professional workflow (`context.workflowKey` starts with
 *   `professional.`: node-output spills, record sets, generic http/browser/artifact nodes), or
 * - any Professional document references it (a snapshot's bytes or an extraction's normalized
 *   text). Artifacts are content-addressed and shared across writers, so the first writer's
 *   label alone does not decide: identical bytes stored later by Professional are private too.
 *
 * All checks fail closed for the generic routes; the composition root wires them as the
 * platform's artifact access guard, so generic code never imports this package.
 */
export const PROFESSIONAL_ARTIFACT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  domain: 'professional',
});

export function hasProfessionalArtifactLabel(labels: Readonly<Record<string, string>> | undefined): boolean {
  return labels?.domain === PROFESSIONAL_ARTIFACT_LABELS.domain;
}

/** Workflow keys of Professional workflows (`professional.<name>`). */
export const PROFESSIONAL_WORKFLOW_KEY_PREFIX = 'professional.';

export function isProfessionalWorkflowKey(workflowKey: string | undefined): boolean {
  return typeof workflowKey === 'string' && workflowKey.startsWith(PROFESSIONAL_WORKFLOW_KEY_PREFIX);
}

/** Whether any Professional document references the artifact (indexed lookups). */
export async function professionalReferencesArtifact(db: Db, artifactId: string): Promise<boolean> {
  const [snapshot, extraction] = await Promise.all([
    db
      .collection(snapshotsCollection.name)
      .findOne({ 'artifact.artifactId': artifactId }, { projection: { _id: 1 } }),
    db
      .collection(extractionsCollection.name)
      .findOne({ 'textArtifact.artifactId': artifactId }, { projection: { _id: 1 } }),
  ]);
  return snapshot !== null || extraction !== null;
}

/** The subset of `artifactIds` referenced by a Professional document (two indexed `$in` lookups). */
export async function professionalReferencedArtifactIds(
  db: Db,
  artifactIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(artifactIds)];
  if (ids.length === 0) return new Set();
  const [snapshots, extractions] = await Promise.all([
    db
      .collection(snapshotsCollection.name)
      .find({ 'artifact.artifactId': { $in: ids } }, { projection: { _id: 0, 'artifact.artifactId': 1 } })
      .toArray(),
    db
      .collection(extractionsCollection.name)
      .find(
        { 'textArtifact.artifactId': { $in: ids } },
        { projection: { _id: 0, 'textArtifact.artifactId': 1 } },
      )
      .toArray(),
  ]);
  const found = new Set<string>();
  for (const d of snapshots) found.add((d.artifact as { artifactId: string }).artifactId);
  for (const d of extractions) found.add((d.textArtifact as { artifactId: string }).artifactId);
  return found;
}
