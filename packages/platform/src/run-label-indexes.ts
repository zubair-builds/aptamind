import type { Collection, Db, Document } from 'mongodb';
import { contentHash } from '@aptamind/contracts';

/**
 * Indexes the composition root adds to the runtime's `workflow_runs` for the labels its domains
 * query run history by (the generic runtime indexes no domain labels). Partial, not sparse: a
 * sparse compound index still holds every run through `createdAt`.
 */
export interface RunLabelIndexSpec {
  key: Record<string, 1 | -1>;
  /** Preferred name (a replacement of a legacy index that holds the name gets a derived one). */
  name: string;
  partialFilterExpression: Document;
}

/** Retryable while another process converges the same indexes concurrently (as FE-1 `syncIndexes`). */
const RACE_CODES = new Set([
  85, // IndexOptionsConflict
  86, // IndexKeySpecsConflict
  276, // IndexBuildAborted
]);
const ATTEMPTS = 5;

const sameKey = (a: Document, b: Document) =>
  JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));

function matches(index: Document, spec: RunLabelIndexSpec): boolean {
  return (
    sameKey(index.key as Document, spec.key) &&
    !index.sparse &&
    !index.unique &&
    contentHash(index.partialFilterExpression ?? null) === contentHash(spec.partialFilterExpression)
  );
}

/** The name a replacement is built under while a legacy index still holds `spec.name`. */
export function replacementIndexName(spec: RunLabelIndexSpec): string {
  return `${spec.name}__${contentHash({ key: spec.key, p: spec.partialFilterExpression }).slice(0, 8)}`;
}

const isIndexNotFound = (err: unknown) =>
  (err as { codeName?: string }).codeName === 'IndexNotFound' || (err as { code?: number }).code === 27;

/**
 * Idempotently converge `workflow_runs` on `specs`, never leaving a key without an index: a spec
 * satisfied by any index on its key with its definition (under whatever name) is left alone;
 * otherwise the replacement is **built first** — under the spec's name, or, while a legacy index
 * (e.g. the earlier sparse variant) holds that name, under `replacementIndexName` — and only then
 * are the other indexes on the same key dropped (IndexNotFound tolerated: a concurrent process
 * may have dropped them). Concurrent callers compute the same names and converge; the server's
 * race codes 85/86/276 are retried with bounded backoff. Used by the migrations and the lock-busy
 * fallback.
 */
export async function ensureRunLabelIndexes(db: Db, specs: readonly RunLabelIndexSpec[]): Promise<void> {
  const runs = db.collection('workflow_runs');
  for (const spec of specs) await ensureOne(runs, spec);
}

async function ensureOne(runs: Collection, spec: RunLabelIndexSpec): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const existing = await runs
        .listIndexes()
        .toArray()
        .catch((err: { codeName?: string }) => {
          if (err.codeName === 'NamespaceNotFound') return [] as Document[];
          throw err;
        });
      const onKey = existing.filter((i) => sameKey(i.key as Document, spec.key));
      if (!onKey.some((i) => matches(i, spec))) {
        const nameTaken = existing.some((i) => i.name === spec.name);
        await runs.createIndex(spec.key, {
          name: nameTaken ? replacementIndexName(spec) : spec.name,
          partialFilterExpression: spec.partialFilterExpression,
        });
      }
      for (const legacy of onKey.filter((i) => !matches(i, spec)))
        await runs.dropIndex(String(legacy.name)).catch((err: unknown) => {
          if (!isIndexNotFound(err)) throw err;
        });
      return;
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (attempt >= ATTEMPTS || code === undefined || !RACE_CODES.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt));
    }
  }
}
