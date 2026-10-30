/**
 * @aptamind/market — Market Intelligence domain.
 *
 * Owns the meaning of sources, observations, companies, jobs, employment intelligence,
 * reconciliation, lifecycle, verification, freshness and review. Depends on the generic
 * runtime only through capabilities and narrow ports; never the other way round.
 */
export * from './contracts';
export * from './context';
export * from './market-domain';
export * from './collections';
export * from './migrations';
export * from './system-sources';
export * from './merge-chain';

export * from './sources/source.schema';
export * from './sources/source.service';
export * from './sources/upload-only';
export * from './sources/providers/uk-sponsor-register';
export * from './sources/providers/registers';
export * from './companies/external-ids';
export * from './observations/schemas';
export * from './observations/observation.service';
export * from './companies/company.schema';
export * from './companies/company.service';
export * from './companies/company-pipeline';
export * from './companies/normalize';
export * from './jobs/job.schema';
export * from './jobs/job.service';
export * from './jobs/job-pipeline';
export * from './jobs/lifecycle';
export * from './jobs/evidence';
export * from './jobs/evidence.service';
export * from './jobs/fingerprint';
export * from './jobs/title-tokens';
export * from './jobs/reinterpret-backfill';
export * from './resolution/company-resolver';
export * from './resolution/job-resolver';
export * from './reconciliation/company-reconciler';
export * from './reconciliation/job-reconciler';
export * from './review/schemas';
export * from './review/review.repository';
export * from './review/review.service';
export * from './review/triage';
export * from './review/audit';
export * from './verification/schemas';
export * from './verification/verification.service';
export * from './freshness/policies';
export * from './freshness/freshness.service';
export * from './freshness/source-freshness';
export * from './retention/policy';
export * from './retention/retention.service';
export * from './signals/schemas';
export * from './queries/dashboard';
export * from './api';
export * from './workflow-nodes';
export * from './workflows';

export * as connectors from './connectors';
export * as discovery from './discovery';
export * as enrichment from './enrichment';
export * from './sources/snapshot-upload';
export * from './imports/import.schema';
export * from './imports/import-report';
export * from './imports/import.service';
export * from './fixtures';
