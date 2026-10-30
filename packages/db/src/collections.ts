import type { Collection, CreateIndexesOptions, Db, Document, IndexSpecification } from 'mongodb';
import type { z } from 'zod';
import { zodToMongoJsonSchema } from './json-schema';

export interface IndexSpec {
  key: IndexSpecification;
  options: CreateIndexesOptions & { name: string };
  /** Why this index exists — surfaced in docs/data-model.md and reviewed explicitly. */
  rationale: string;
}

export interface CollectionSpec<T extends Document> {
  name: string;
  /** Runtime schema applied at the application boundary on writes. */
  schema: z.ZodType<T>;
  /** Current document schema version. */
  schemaVersion: number;
  indexes: IndexSpec[];
  /**
   * MongoDB-side `$jsonSchema` validator (defence in depth). Derived from `schema` by default
   * (`zodToMongoJsonSchema`); `false` opts out, a document overrides.
   */
  validator?: Document | false;
  description: string;
}

/** Define a collection; its server-side validator is derived from the Zod schema unless given. */
export function defineCollection<T extends Document>(spec: CollectionSpec<T>): CollectionSpec<T> {
  if (spec.validator === undefined) {
    return { ...spec, validator: { $jsonSchema: zodToMongoJsonSchema(spec.schema as never) } };
  }
  return spec;
}

export function getCollection<T extends Document>(db: Db, spec: CollectionSpec<T>): Collection<T> {
  return db.collection<T>(spec.name);
}

/**
 * Validate a document against its collection schema before writing.
 * Mongo's flexible schema is never an excuse for unvalidated JSON.
 */
export function validateDocument<T extends Document>(spec: CollectionSpec<T>, doc: unknown): T {
  const parsed = spec.schema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new SchemaValidationError(spec.name, issues);
  }
  return parsed.data;
}

export class SchemaValidationError extends Error {
  readonly code = 'validation_failed';
  constructor(
    public readonly collection: string,
    public readonly issues: string[],
  ) {
    super(`Document for ${collection} failed validation: ${issues.join('; ')}`);
    this.name = 'SchemaValidationError';
  }
}

/**
 * Idempotently create collections, apply validators and create indexes.
 * Safe to call on every boot and from migrations.
 */
export async function ensureCollections(db: Db, specs: CollectionSpec<Document>[]): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const spec of specs) {
    if (!existing.has(spec.name)) {
      try {
        await db.createCollection(
          spec.name,
          spec.validator ? { validator: spec.validator, validationLevel: 'moderate' } : {},
        );
      } catch (err) {
        // Another process may have created it concurrently.
        if ((err as { codeName?: string }).codeName !== 'NamespaceExists') throw err;
      }
    } else if (spec.validator) {
      await db.command({ collMod: spec.name, validator: spec.validator, validationLevel: 'moderate' });
    }
    if (spec.indexes.length) await syncIndexes(db.collection(spec.name), spec.indexes);
  }
}

/** Retryable while another process converges the same indexes concurrently (FE-1). */
const INDEX_RACE_CODES = new Set([
  85, // IndexOptionsConflict — another process recreated the index with the old view
  86, // IndexKeySpecsConflict
  276, // IndexBuildAborted — another process dropped the index while our build ran
]);
const INDEX_SYNC_ATTEMPTS = 4;

/**
 * Drop indexes whose definition changed, then create every spec index. Two processes booting
 * together can interleave (one aborts the other's build, or recreates with a stale view); each
 * attempt re-lists and re-compares, so they converge on the spec's definition.
 */
async function syncIndexes(col: Collection, specs: CollectionSpec<Document>['indexes']): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await dropChangedIndexes(col, specs);
      await col.createIndexes(
        specs.map((i) => ({ key: i.key as Document, ...i.options })) as Parameters<
          Collection['createIndexes']
        >[0],
      );
      return;
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (attempt >= INDEX_SYNC_ATTEMPTS || code === undefined || !INDEX_RACE_CODES.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

const INDEX_OPTIONS_COMPARED = ['unique', 'sparse', 'partialFilterExpression', 'expireAfterSeconds'] as const;

/**
 * An index whose definition changed in its spec (same name, different key or options) is
 * dropped so the spec's definition can be created — `createIndexes` would otherwise fail
 * with an options conflict and the change would never reach existing databases.
 */
async function dropChangedIndexes(
  col: Collection,
  specs: CollectionSpec<Document>['indexes'],
): Promise<void> {
  let existing: Document[];
  try {
    existing = await col.listIndexes().toArray();
  } catch {
    return; // collection not created yet
  }
  for (const spec of specs) {
    const name = (spec.options as { name?: string } | undefined)?.name;
    const current = existing.find((i) => i.name === name);
    if (!name || !current) continue;
    const opts = (spec.options ?? {}) as unknown as Record<string, unknown>;
    const same =
      sameKey(current, spec.key as Record<string, unknown>, opts) &&
      INDEX_OPTIONS_COMPARED.every((o) => canonical(current[o]) === canonical(opts[o]));
    if (same) continue;
    try {
      await col.dropIndex(name);
    } catch (err) {
      // Another process booting concurrently already dropped it; the create below converges.
      if (!isIndexNotFound(err)) throw err;
    }
  }
}

/**
 * Compares an existing index's key (and, for text indexes, its text options) with the spec,
 * field order included. MongoDB reports a text index's key as its non-text fields with the run
 * of text fields replaced by `{_fts: 'text', _ftsx: 1}` and the text fields under `weights`;
 * comparing the raw key would make every text index look changed and rebuild on every boot.
 */
function sameKey(
  current: Document,
  specKey: Record<string, unknown>,
  opts: Record<string, unknown>,
): boolean {
  const currentEntries = Object.entries(current.key as Record<string, unknown>);
  const specEntries = Object.entries(specKey);
  const isText = specEntries.some(([, v]) => v === 'text');
  if (!isText)
    return current.key?._fts !== 'text' && JSON.stringify(currentEntries) === JSON.stringify(specEntries);
  // Expected server key: the contiguous text run collapses to _fts/_ftsx at its first position.
  const expected: [string, unknown][] = [];
  let inserted = false;
  for (const [f, v] of specEntries) {
    if (v !== 'text') expected.push([f, v]);
    else if (!inserted) {
      expected.push(['_fts', 'text'], ['_ftsx', 1]);
      inserted = true;
    }
  }
  const weights: Record<string, unknown> = Object.fromEntries(
    specEntries.filter(([, v]) => v === 'text').map(([f]) => [f, 1]),
  );
  Object.assign(weights, (opts.weights ?? {}) as Record<string, unknown>);
  return (
    JSON.stringify(currentEntries) === JSON.stringify(expected) &&
    canonical(current.weights ?? {}) === canonical(weights) &&
    (current.default_language ?? 'english') === (opts.default_language ?? 'english') &&
    (current.language_override ?? 'language') === (opts.language_override ?? 'language')
  );
}

function isIndexNotFound(err: unknown): boolean {
  const e = err as { code?: number; codeName?: string };
  return e.code === 27 || e.codeName === 'IndexNotFound';
}

function canonical(v: unknown): string {
  if (v === undefined || v === false) return '';
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );
}
