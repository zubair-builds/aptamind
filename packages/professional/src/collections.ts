import type { Document } from 'mongodb';
import type { CollectionSpec } from '@aptamind/db';
import { eventsCollection } from './events/event.schema';
import { extractionsCollection } from './extraction/extraction.schema';
import { observationsCollection } from './observations/observation.schema';
import { reviewItemsCollection } from './review/review.schema';
import { acquisitionsCollection, snapshotsCollection, sourcesCollection } from './sources/source.schema';
import { subjectsCollection } from './subjects/subject.schema';
import { careerTargetsCollection, careerTargetVersionsCollection } from './targets/target.schema';

/**
 * Professional collections (`professional_*`), declared through the Foundation
 * collection-spec mechanism: Zod schema at the application boundary, a derived `$jsonSchema`
 * validator server-side, and indexes with their rationale. Collections are added by the PR
 * that first needs them (P0.3: the core evidence pipeline).
 */
export const professionalCollections = [
  subjectsCollection,
  sourcesCollection,
  snapshotsCollection,
  acquisitionsCollection,
  extractionsCollection,
  observationsCollection,
  eventsCollection,
  reviewItemsCollection,
  careerTargetsCollection,
  careerTargetVersionsCollection,
] as unknown as CollectionSpec<Document>[];
