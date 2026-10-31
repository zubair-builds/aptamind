import type { Document } from 'mongodb';
import type { CollectionSpec } from '@aptamind/db';
import { aiOperationsCollection } from './ai/ai-operations';
import { companiesCollection } from './companies/company.schema';
import {
  jobEvidenceCollection,
  jobEvidenceSweepsCollection,
  jobLifecycleCheckpointsCollection,
  jobLifecycleFailuresCollection,
} from './jobs/evidence';
import { jobsCollection } from './jobs/job.schema';
import {
  companyObservationsCollection,
  jobObservationsCollection,
  snapshotsCollection,
} from './observations/schemas';
import {
  auditEventsCollection,
  reviewItemsCollection,
  reviewOperationsCollection,
  reviewRetryIntentsCollection,
} from './review/schemas';
import {
  companySignalStateCollection,
  signalWriterCursorsCollection,
  signalsCollection,
} from './signals/schemas';
import { sourceRunOutcomesCollection, sourcesCollection } from './sources/source.schema';
import { importsCollection } from './imports/import.schema';
import { jobVerificationsCollection } from './verification/schemas';

export const marketCollections = [
  sourcesCollection,
  sourceRunOutcomesCollection,
  snapshotsCollection,
  companyObservationsCollection,
  jobObservationsCollection,
  companiesCollection,
  jobsCollection,
  jobEvidenceCollection,
  jobLifecycleCheckpointsCollection,
  jobEvidenceSweepsCollection,
  jobLifecycleFailuresCollection,
  reviewItemsCollection,
  reviewOperationsCollection,
  reviewRetryIntentsCollection,
  auditEventsCollection,
  jobVerificationsCollection,
  signalsCollection,
  companySignalStateCollection,
  signalWriterCursorsCollection,
  aiOperationsCollection,
  importsCollection,
] as unknown as CollectionSpec<Document>[];
