import type { Db } from 'mongodb';
import { isDuplicateKeyError } from '@aptamind/db';
import { strictNameKey, strictNameKeyV1 } from './companies/normalize';
import { sourceNameKey, sourceNameTokens } from './sources/source.schema';

/**
 * Indexes Market no longer declares. `ensureCollections` creates and updates declared indexes but
 * never drops undeclared ones, so retired indexes are removed by this migration step.
 */
export const RETIRED_MARKET_INDEXES: Array<{ collection: string; name: string; replacedBy: string }> = [
  { collection: 'market_companies', name: 'by_last_changed', replacedBy: 'list_changed' },
  { collection: 'market_jobs', name: 'by_last_changed', replacedBy: 'list_changed' },
];

/** Idempotently drop the retired Market indexes. */
export async function dropRetiredMarketIndexes(db: Db): Promise<string[]> {
  const dropped: string[] = [];
  for (const { collection, name } of RETIRED_MARKET_INDEXES) {
    const col = db.collection(collection);
    const exists = (
      await col
        .listIndexes()
        .toArray()
        .catch(() => [])
    ).some((i) => i.name === name);
    if (!exists) continue;
    await col.dropIndex(name).catch((err: { codeName?: string }) => {
      if (err.codeName !== 'IndexNotFound') throw err;
    });
    dropped.push(`${collection}.${name}`);
  }
  return dropped;
}

/**
 * Migration (2026-09-29-013, released): set `nameKey` (`sourceNameKey(name)`) on every source that
 * lacks it, in `_id` order and batches (idempotent, resumable).
 */
export async function migrateSourceNameKeys(db: Db, batchSize = 500): Promise<{ updated: number }> {
  const col = db.collection<{ _id: string; name?: string }>('market_sources');
  let updated = 0;
  let after = '';
  for (;;) {
    const batch = await col
      .find({ _id: { $gt: after }, nameKey: { $exists: false } }, { projection: { name: 1 } })
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();
    if (!batch.length) break;
    const res = await col.bulkWrite(
      batch.map((s) => ({
        updateOne: {
          filter: { _id: s._id, nameKey: { $exists: false } },
          update: { $set: { nameKey: sourceNameKey(s.name ?? '') } },
        },
      })),
      { ordered: false },
    );
    updated += res.modifiedCount;
    after = batch[batch.length - 1]!._id;
  }
  return { updated };
}

/**
 * Migration (widen phase): set `nameTokens` (`sourceNameTokens(name)`) on every source that lacks
 * it, in `_id` order and batches (idempotent, resumable). `nameKey` is left as it is (still
 * written and read this release). Each write is conditional on the name it was computed from
 * (`name: s.name`): a rename that lands between the read and the write keeps the tokens the rename
 * wrote. `hooks.afterRead` exists for tests (it runs between a batch's read and its write).
 */
export async function migrateSourceNameTokens(
  db: Db,
  batchSize = 500,
  hooks: { afterRead?: (ids: string[]) => Promise<void> } = {},
): Promise<{ updated: number }> {
  const col = db.collection<{ _id: string; name?: string }>('market_sources');
  let updated = 0;
  let after = '';
  for (;;) {
    const batch = await col
      .find({ _id: { $gt: after }, nameTokens: { $exists: false } }, { projection: { name: 1 } })
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();
    if (!batch.length) break;
    await hooks.afterRead?.(batch.map((s) => s._id));
    const res = await col.bulkWrite(
      batch.map((s) => ({
        updateOne: {
          filter: { _id: s._id, name: s.name, nameTokens: { $exists: false } },
          update: { $set: { nameTokens: sourceNameTokens(s.name ?? '') } },
        },
      })),
      { ordered: false },
    );
    updated += res.modifiedCount;
    after = batch[batch.length - 1]!._id;
  }
  return { updated };
}

/**
 * Migration (name-norm/2): add the name-norm/2 name key next to every stored name-norm/1 key that
 * differs, for active companies, in `_id` order and batches. Additive and idempotent: keys are
 * only ever added (`$addToSet`, filtered on `status: 'active'`), never replaced or removed, so a
 * replay or a crash mid-way is safe. A v2 key that another company already holds is not added (the
 * unique index refuses it) and is counted as a clash. Such a clash shows up as the "Several
 * companies share the legal name" review the next time a row with that name is resolved (both
 * companies own that v2 name key). Returns counts for the log.
 */
export async function migrateCompanyNameKeysV2(
  db: Db,
  batchSize = 500,
): Promise<{ scanned: number; updated: number; keysAdded: number; clashes: number }> {
  const col = db.collection<{
    _id: string;
    status: string;
    identityKeys: string[];
    identity: { displayName?: { value?: string | null }; legalName?: { value?: string | null } };
  }>('market_companies');
  const counts = { scanned: 0, updated: 0, keysAdded: 0, clashes: 0 };
  let after = '';
  for (;;) {
    const batch = await col
      .find(
        { _id: { $gt: after }, status: 'active' },
        { projection: { identityKeys: 1, 'identity.displayName.value': 1, 'identity.legalName.value': 1 } },
      )
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();
    if (!batch.length) break;
    for (const c of batch) {
      counts.scanned++;
      const wanted = companyNameKeysV2(c.identityKeys, [
        c.identity.displayName?.value,
        c.identity.legalName?.value,
      ]);
      let added = 0;
      for (const key of wanted) {
        try {
          // Only while still active: a company merged since the read keeps no keys of its own.
          const r = await col.updateOne(
            { _id: c._id, status: 'active' },
            { $addToSet: { identityKeys: key } },
          );
          if (r.modifiedCount) added++;
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err;
          counts.clashes++;
        }
      }
      counts.keysAdded += added;
      if (added) counts.updated++;
    }
    after = batch[batch.length - 1]!._id;
  }
  return counts;
}

/**
 * The name-norm/2 `name:` keys a company should carry beside its stored keys: for each of its
 * names whose v1 key it holds (with any `#qualifier`) and whose v2 key differs; and, for a name
 * whose v1 key was empty (a non-Latin name, which got no name key under v1), its v2 key when the
 * company holds no name key at all.
 */
export function companyNameKeysV2(identityKeys: string[], names: Array<string | null | undefined>): string[] {
  const held = new Set(identityKeys);
  const nameKeys = identityKeys.filter((k) => k.startsWith('name:'));
  const out = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    const v1 = strictNameKeyV1(name);
    const v2 = strictNameKey(name);
    if (!v2 || v1 === v2) continue;
    if (!v1) {
      if (!nameKeys.length) out.add(`name:${v2}`);
      continue;
    }
    for (const k of nameKeys) {
      const [base, qualifier] = k.slice(5).split('#') as [string, string | undefined];
      if (base !== v1) continue;
      const next = `name:${v2}${qualifier !== undefined ? `#${qualifier}` : ''}`;
      if (!held.has(next)) out.add(next);
    }
  }
  return [...out].sort();
}
