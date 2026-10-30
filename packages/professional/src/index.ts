/**
 * @aptamind/professional — Professional Intelligence domain.
 *
 * Owns what is true about a professional (the subject), what evidence supports it, what the
 * subject confirmed and which career directions they target (ADR-0020). Depends on the generic
 * runtime only through capabilities and narrow ports, and never imports another domain
 * (enforced by `pnpm check:arch`).
 */
export * from './contracts';
export * from './context';
export * from './professional-domain';
export * from './collections';
export * from './schema-versions';
export * from './privacy/artifacts';
export * from './documents';
export * from './subjects/subject.schema';
export * from './subjects/subject.service';
export * from './subjects/subject-overview';
export * from './sources/source.schema';
export * from './sources/linkedin';
export * from './sources/policies';
export * from './sources/source.service';
export * from './sources/snapshot.service';
export * from './sources/upload';
export * from './sources/ingest.service';
export * from './structured/forms';
export * from './structured/extractor';
export * from './extraction/extraction.service';
export * from './observations/observation.service';
export * from './targets/target.schema';
export * from './targets/target.service';
export * from './targets/transitions';
export * from './targets/views';
export * from './extraction/extraction.schema';
export * from './observations/observation.schema';
export * from './observations/payload';
export * from './events/event.schema';
export * from './events/event.store';
export * from './api/errors';
export * from './api/pagination';
export * from './api/present';
export * from './privacy/logger';
export * from './review/review.schema';
export * from './assertions/transitions';
export * from './assertions/revival';
export * from './reconciliation';
export * from './workflow-nodes';
export * from './workflows';
