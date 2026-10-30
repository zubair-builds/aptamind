import type { Db } from 'mongodb';
import type { EventDoc } from '../events/event.schema';
import type { EventStore } from '../events/event.store';
import { SOURCE_KINDS, type SourceKind } from '../sources/source.schema';
import type { SubjectDoc } from './subject.schema';
import type { SubjectService } from './subject.service';

export interface SubjectOverview {
  subject: SubjectDoc;
  counts: {
    sources: number;
    sourcesByKind: Record<SourceKind, number>;
    snapshots: number;
    /**
     * Snapshots that need an operator — processing `pending` (never started) or `failed` — for an
     * active subject; 0 for an archived subject (read-only: nothing can be reprocessed).
     */
    unprocessedSnapshots: number;
    observations: number;
    openReviewItems: number;
    /** Open career targets (proposed, active, paused). */
    targets: number;
  };
  /** The subject's latest events (≤ 20, newest first): consent, reference, archive, sources. */
  events: EventDoc[];
}

/**
 * `GET /api/professional/subjects/:id` (overview). Counts come from indexed `subjectId` queries;
 * profile version and open confirmation requests join when those exist (P3.2 / P3.3).
 */
export async function subjectOverview(
  db: Db,
  subjects: SubjectService,
  events: EventStore,
  id: string,
  unprocessed: (subjectId: string) => Promise<number>,
): Promise<SubjectOverview> {
  const subject = await subjects.get(id);
  const [byKind, snapshots, unprocessedSnapshots, observations, openReviewItems, targets, recent] =
    await Promise.all([
      db
        .collection('professional_sources')
        .aggregate<{ _id: SourceKind; n: number }>([
          { $match: { subjectId: id } },
          { $group: { _id: '$kind', n: { $sum: 1 } } },
        ])
        .toArray(),
      db.collection('professional_snapshots').countDocuments({ subjectId: id }),
      subject.status === 'active' ? unprocessed(id) : Promise.resolve(0),
      db.collection('professional_observations').countDocuments({ subjectId: id }),
      db.collection('professional_review_items').countDocuments({ subjectId: id, status: 'open' }),
      db
        .collection('professional_career_targets')
        .countDocuments({ subjectId: id, status: { $in: ['proposed', 'active', 'paused'] } }),
      events.list({ subjectId: id }, 20),
    ]);
  const sourcesByKind = Object.fromEntries(SOURCE_KINDS.map((k) => [k, 0])) as Record<SourceKind, number>;
  for (const r of byKind) sourcesByKind[r._id] = r.n;
  return {
    subject,
    counts: {
      sources: Object.values(sourcesByKind).reduce((a, b) => a + b, 0),
      sourcesByKind,
      snapshots,
      unprocessedSnapshots,
      observations,
      openReviewItems,
      targets,
    },
    events: recent,
  };
}
