import type { Db, Document } from 'mongodb';
import { type CollectionSpec, ensureCollections, isDuplicateKeyError } from '@aptamind/db';
import { professionalCollections } from './collections';

/**
 * Collection-definition versions (validator + indexes) of every Professional collection. Bump
 * a collection's number in the PR that changes its spec (`collections.test.ts` pins each spec's
 * fingerprint to its version, so a forgotten bump fails). v0.1 deploys that change a closed
 * validator are drain-first (supervisor ruling, DECISION_LOG bf98d4d): these numbers make a
 * process running older code unable to downgrade what a newer one applied.
 */
export const PROFESSIONAL_COLLECTION_VERSIONS: Readonly<Record<string, number>> = Object.freeze({
  professional_subjects: 4, // P1.2: acquisitionCount; P1.3: extractionCount; P5.1: targetsRev (all optional, widened)
  professional_sources: 1,
  professional_snapshots: 4, // P1.2: chronology, previousSourceAsOf, by_source_created; v3: random ids; v4 (P1.3): ingest
  professional_acquisitions: 1, // P1.2: new
  professional_extractions: 1,
  professional_observations: 2, // P1.3: by_subject_created
  professional_events: 1,
  professional_review_items: 1,
  professional_career_targets: 1, // P5.1: new
  professional_career_target_versions: 1, // P5.1: new
});

/** Where the applied versions are recorded: `{ _id: collection name, version, appliedAt }`. */
export const SCHEMA_VERSIONS_COLLECTION = 'professional_schema_versions';

interface SchemaVersionDoc {
  _id: string;
  version: number;
  appliedAt: Date;
}

export interface EnsureResult {
  applied: string[];
  /** Collections whose recorded version is newer than this code's: left untouched. */
  skippedNewer: string[];
}

/**
 * Creates collections and applies validators and indexes, skipping any collection whose
 * recorded version is newer than this code's definition (validator and indexes), so an older
 * process that boots after a newer one (or a stale migration) does not re-close a validator a
 * newer release widened. The recorded version only moves forward (`$max`, so two concurrent
 * processes cannot lower it). This is a safety net, not a guarantee: the read-then-apply
 * sequence is not atomic, so an older and a newer process booting at the same moment could
 * interleave (older reads, newer applies, older applies) — drain-first deploys (§15) rule that
 * out. It also cannot protect against processes of releases that predate it (P1.1).
 */
export async function ensureVersionedCollections(
  db: Db,
  specs: readonly CollectionSpec<Document>[] = professionalCollections,
  versions: Readonly<Record<string, number>> = PROFESSIONAL_COLLECTION_VERSIONS,
  warn: (msg: string, data: Record<string, unknown>) => void = () => {},
): Promise<EnsureResult> {
  const col = db.collection<SchemaVersionDoc>(SCHEMA_VERSIONS_COLLECTION);
  const recorded = new Map((await col.find({}).toArray()).map((d) => [d._id, d.version]));
  const versionOf = (name: string) => {
    const v = versions[name];
    if (v === undefined) throw new Error(`No collection version for ${name}`);
    return v;
  };
  const apply = specs.filter((s) => (recorded.get(s.name) ?? 0) <= versionOf(s.name));
  const skippedNewer = specs.filter((s) => !apply.includes(s)).map((s) => s.name);
  if (skippedNewer.length)
    warn('professional collections skipped: a newer release applied their definitions', {
      collections: skippedNewer,
    });
  await ensureCollections(db, [...apply]);
  const now = new Date();
  for (const s of apply) {
    const record = () =>
      col.updateOne(
        { _id: s.name },
        { $max: { version: versionOf(s.name) }, $set: { appliedAt: now } },
        { upsert: true },
      );
    // Two processes upserting the first record race on `_id`; the retry updates the winner's.
    await record().catch((err) => (isDuplicateKeyError(err) ? record() : Promise.reject(err)));
  }
  return { applied: apply.map((s) => s.name), skippedNewer };
}
