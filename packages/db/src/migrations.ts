import type { Db } from 'mongodb';
import { isDuplicateKeyError } from './mongo';

export interface Migration {
  /** Sortable, unique identifier, e.g. `2026-09-27-001-initial-indexes`. */
  id: string;
  description: string;
  up(db: Db): Promise<void>;
}

interface MigrationRecord {
  _id: string;
  description: string;
  appliedAt: Date;
  durationMs: number;
}

interface LockRecord {
  _id: string;
  owner: string;
  acquiredAt: Date;
  expiresAt: Date;
}

const LOCK_ID = 'migrations';

/**
 * Apply pending migrations in id order. A lease-based lock in Mongo prevents two
 * processes from migrating at once; migrations themselves must be idempotent.
 */
export async function runMigrations(
  db: Db,
  migrations: Migration[],
  opts: { owner: string; lockTtlMs?: number; log?: (msg: string) => void } = { owner: 'unknown' },
): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const locks = db.collection<LockRecord>('_locks');
  const applied = db.collection<MigrationRecord>('_migrations');
  const now = new Date();
  const ttl = opts.lockTtlMs ?? 10 * 60_000;

  await locks.deleteOne({ _id: LOCK_ID, expiresAt: { $lt: now } });
  try {
    await locks.insertOne({
      _id: LOCK_ID,
      owner: opts.owner,
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + ttl),
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new Error('Another process holds the migration lock');
    throw err;
  }

  const done: string[] = [];
  try {
    const appliedIds = new Set(
      (await applied.find({}, { projection: { _id: 1 } }).toArray()).map((m) => m._id),
    );
    const ids = new Set<string>();
    for (const m of migrations) {
      if (ids.has(m.id)) throw new Error(`Duplicate migration id ${m.id}`);
      ids.add(m.id);
    }
    for (const m of [...migrations].sort((a, b) => a.id.localeCompare(b.id))) {
      if (appliedIds.has(m.id)) continue;
      const started = Date.now();
      log(`applying migration ${m.id}: ${m.description}`);
      await m.up(db);
      await applied.insertOne({
        _id: m.id,
        description: m.description,
        appliedAt: new Date(),
        durationMs: Date.now() - started,
      });
      done.push(m.id);
    }
  } finally {
    await locks.deleteOne({ _id: LOCK_ID, owner: opts.owner });
  }
  return done;
}
