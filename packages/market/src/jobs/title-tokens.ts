/**
 * Search tokens of a job title (M7.3 search, stream-local; no text index). Lower-cased, Unicode
 * NFKD with diacritics removed, split on anything that is not a letter or digit — except that a
 * trailing `+`/`#` (`c++`, `c#`, `f#`) and a leading `.` (`.net`) stay part of the token; a dotted
 * token is also indexed without its dot (`.net` → `net`). Single characters and stop words are
 * kept, so "IT", "C" and "Head of" remain searchable. Bounded (64 distinct tokens).
 */
import type { Db } from 'mongodb';

export const TITLE_TOKENS_VERSION = 'title-tokens/1';

const TOKEN = /\.?[\p{L}\p{N}]+[+#]*/gu;

export function titleTokens(title: string | null | undefined): string[] {
  if (!title) return [];
  const normalized = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
  const out = new Set<string>();
  for (const m of normalized.matchAll(TOKEN)) {
    let t = m[0];
    // A dot is only a token prefix at the start of a word (".net"), not inside "node.js".
    if (t.startsWith('.') && m.index > 0 && /[\p{L}\p{N}]/u.test(normalized[m.index - 1] ?? ''))
      t = t.slice(1);
    out.add(t);
    if (t.startsWith('.') && t.length > 1) out.add(t.slice(1));
    if (out.size >= 64) break;
  }
  return [...out];
}

/** The text index the first job-search implementation created (replaced by title tokens). */
const LEGACY_TEXT_INDEX = 'list_title_text';

/**
 * Migration: drop the legacy title text index and set `identity.titleTokens` on every job that
 * lacks it, in `_id` order and batches (idempotent; resumable — a rerun continues with the jobs
 * still missing tokens). Jobs are otherwise tokenised by every reconciliation.
 */
export async function migrateJobTitleTokens(db: Db, batchSize = 500): Promise<{ updated: number }> {
  const col = db.collection<{
    _id: string;
    identity?: { title?: { value?: string | null }; normalizedTitle?: string };
  }>('market_jobs');
  const indexes = await col
    .listIndexes()
    .toArray()
    .catch(() => []);
  if (indexes.some((i) => i.name === LEGACY_TEXT_INDEX))
    await col.dropIndex(LEGACY_TEXT_INDEX).catch(() => {});
  let updated = 0;
  let after = '';
  for (;;) {
    const batch = await col
      .find(
        { _id: { $gt: after }, 'identity.titleTokens': { $exists: false } },
        { projection: { 'identity.title.value': 1, 'identity.normalizedTitle': 1 } },
      )
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();
    if (!batch.length) break;
    const res = await col.bulkWrite(
      batch.map((j) => ({
        updateOne: {
          filter: { _id: j._id, 'identity.titleTokens': { $exists: false } },
          update: {
            $set: {
              'identity.titleTokens': titleTokens(
                j.identity?.title?.value ?? j.identity?.normalizedTitle ?? '',
              ),
            },
          },
        },
      })),
      { ordered: false },
    );
    updated += res.modifiedCount;
    after = batch[batch.length - 1]!._id;
  }
  return { updated };
}
