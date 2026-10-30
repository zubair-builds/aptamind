import type { Db } from 'mongodb';
import { getCollection } from '@aptamind/db';
import { apiBaseOfListingUrl, getAdapter } from '../connectors';
import { ATS_PROVIDERS, type AtsProvider, normalizeProviderKey } from '../contracts/common';
import type { CopyBoard } from '../jobs/job.schema';
import { auditEventsCollection } from '../review/schemas';
import type { SourceDoc } from './source.schema';

export {
  authoritativeTierOf,
  hasUnrecognisedProvider,
  isAuthoritativeSource,
  type SourceStanding,
} from '../jobs/authority';
export type { CopyBoard } from '../jobs/job.schema';
export { boardIdentity, sameBoard } from '../jobs/board';

/**
 * The board a source currently reads (MEDIUM-2): its endpoint URL and board token and, for an ATS,
 * the API base derived from them exactly as fetch derives it (the endpoint URL, or the adapter
 * default host without one). `apiBase` is null when it cannot be recovered (never guessed).
 */
export function boardOfSource(s: Pick<SourceDoc, 'provider' | 'endpoint'>): CopyBoard {
  const endpointUrl = s.endpoint.url ?? null;
  const boardToken = s.endpoint.boardToken ?? null;
  const provider = normalizeProviderKey(s.provider);
  let apiBase: string | null = null;
  if ((ATS_PROVIDERS as readonly string[]).includes(provider) && boardToken) {
    const adapter = getAdapter(provider as AtsProvider);
    apiBase = endpointUrl ? apiBaseOfListingUrl(endpointUrl, boardToken, adapter) : adapter.apiBases.default;
  }
  return { endpointUrl, boardToken, apiBase, provider };
}

/**
 * The board to record on a copy seen on `s` in a listing fetched at `at`: the source's current
 * board, or `null` (unknown) when the endpoint changed after that fetch — the listing may have been
 * read from the previous endpoint.
 */
export function boardSeenAt(
  s: Pick<SourceDoc, 'provider' | 'endpoint' | 'endpointChangedAt'>,
  at: Date,
): CopyBoard | null {
  if (s.endpointChangedAt && s.endpointChangedAt.getTime() > at.getTime()) return null;
  return boardOfSource(s);
}

/**
 * Whether the source's endpoint changed after `since` (a copy without a recorded board is read on
 * the current endpoint only when it did not). `source.endpointChangedAt` is the time of the
 * endpoint's LATEST change, written by every endpoint PATCH since it exists; without it (no change
 * since), any `source.updated` audit event carrying an endpoint patch after `since` (every PATCH is
 * audited), or a shrink baseline flagged `endpointChangedAt` after it, means it may have changed.
 */
export async function endpointChangedSince(
  db: Db,
  source: Pick<SourceDoc, '_id' | 'endpointChangedAt' | 'health'>,
  since: Date,
): Promise<boolean> {
  const t = since.getTime();
  if (source.endpointChangedAt) return source.endpointChangedAt.getTime() > t;
  const flagged = source.health.listingBaseline?.endpointChangedAt;
  if (flagged && flagged.getTime() > t) return true;
  const patched = await getCollection(db, auditEventsCollection).findOne(
    {
      'entity.kind': 'source',
      'entity.id': source._id,
      at: { $gt: since },
      action: 'source.updated',
      'details.patch.endpoint': { $exists: true },
    },
    { projection: { _id: 1 } },
  );
  return !!patched;
}
