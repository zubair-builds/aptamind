import type { Actor } from '@aptamind/contracts';
import type { Logger } from '@aptamind/observability';
import type { ReviewRepository } from './review.repository';
import type { ReviewService } from './review.service';

/** Dedupe keys of the pre-M6.2 empty-listing anomaly (`source_anomaly:<sourceId>:empty`). */
export const LEGACY_EMPTY_LISTING_KEY = /^source_anomaly:[^:]+:empty$/;

const LEGACY_REVIEW_ACTOR = { kind: 'system', id: 'market-review-migration' } as Actor;

/**
 * PR #11 (A-M2/B-M1): `market.finalize_job_listing@1` was changed in place. Its old empty-listing
 * guard raised `source_anomaly:<sourceId>:empty`; the M6.2 shrink guard neither reads nor raises
 * that key, so an open item under it is orphaned (confirming it would do nothing). Each is
 * dismissed through the normal resolution operation (audited) with a deterministic operation id,
 * so a repeat — another process starting, a crash midway — resumes or skips, never duplicates.
 * If the listing is still held, the next refresh raises the per-baseline shrink review.
 */
export async function retireLegacyListingReviews(
  reviews: ReviewRepository,
  service: ReviewService,
  logger: Logger,
): Promise<number> {
  const items = await reviews.col
    .find(
      { type: 'source_anomaly', status: 'open', dedupeKey: { $regex: LEGACY_EMPTY_LISTING_KEY.source } },
      { projection: { _id: 1 } },
    )
    .toArray();
  let retired = 0;
  for (const { _id } of items) {
    try {
      await service.resolve(
        _id,
        {
          action: 'dismiss',
          reason:
            'Superseded by the M6.2 listing shrink guard (PR #11): this empty-listing review is no longer read. ' +
            'A listing that is still held raises a per-baseline source_anomaly on its next refresh.',
        },
        LEGACY_REVIEW_ACTOR,
        { operationId: `rop_legacy_empty_${_id}` },
      );
      retired += 1;
    } catch (err) {
      // E.g. an operator is resolving it right now: leave it to them.
      logger.warn({ reviewItemId: _id, err: (err as Error).message }, 'legacy listing review not retired');
    }
  }
  return retired;
}
