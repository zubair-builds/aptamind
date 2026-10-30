import { z } from 'zod';
import { AUTHORITY_TIERS } from '@aptamind/provenance';
import { companyDocSchema } from '../companies/company.schema';
import { SOURCE_FRESHNESS_STATES } from '../freshness/source-freshness';
import { jobDocSchema } from '../jobs/job.schema';
import {
  companyObservationDocSchema,
  jobObservationDocSchema,
  snapshotDocSchema,
} from '../observations/schemas';
import { auditEventDocSchema, REVIEW_ACTIONS, reviewItemDocSchema } from '../review/schemas';
import { signalDocSchema } from '../signals/schemas';
import { sourceDocSchema } from '../sources/source.schema';
import { jobVerificationDocSchema } from '../verification/schemas';
import { REVIEW_QUEUE_STATES } from './review';
import { summaryFactDto } from './summary';
import { isoDateTime, toWire } from './wire';

/**
 * Response DTOs of the Market API (`/api/companies`, `/api/jobs`, `/api/sources`,
 * `/api/review`, …) in their JSON wire form: dates are ISO-8601 strings.
 *
 * Document DTOs are derived from the collection schemas (`toWire`), so a stored-shape change
 * is a DTO change. Route contract tests parse real responses with these schemas; the
 * `docs/programme/contracts/market-*.md` contracts reference them by name.
 */

type AnyObject = z.ZodObject<z.ZodRawShape>;
const wireObject = (s: z.ZodType) => toWire(s) as AnyObject;

// ------------------------------------------------------------------ documents (full)

export const companyDto = wireObject(companyDocSchema);
export const jobDto = wireObject(jobDocSchema);
export const sourceDto = wireObject(sourceDocSchema);
export const snapshotDto = wireObject(snapshotDocSchema);
export const companyObservationDto = wireObject(companyObservationDocSchema);
export const jobObservationDto = wireObject(jobObservationDocSchema);
export const reviewItemDto = wireObject(reviewItemDocSchema);
export const auditEventDto = wireObject(auditEventDocSchema);
export const jobVerificationDto = wireObject(jobVerificationDocSchema);
export const signalDto = wireObject(signalDocSchema);

/** A job in list responses: the description text and its shingles are omitted. */
export const jobListDocDto = jobDto.extend({
  content: (jobDto.shape.content as AnyObject).omit({ descriptionText: true, shingles: true }),
});

/** `Page<T>` (offset pagination, `packages/contracts/src/pagination.ts`). */
export function pageDto<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
  });
}

/** `Page` v2 (list v2 endpoints): `total` is `null` with `count=none`; `nextCursor` is `null` on the last page. */
export function listPageDto<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0).nullable(),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
    nextCursor: z.string().nullable(),
  });
}

/** A workflow run as Market endpoints embed it (runtime document without `input`/`output`). */
export const RUN_STATES = [
  'PENDING',
  'RUNNING',
  'WAITING',
  'CANCELLING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export const runSummaryDto = z.object({
  _id: z.string(),
  workflowKey: z.string(),
  workflowVersion: z.number().int(),
  state: z.enum(RUN_STATES),
  labels: z.record(z.string(), z.string()),
  trigger: z.object({ kind: z.string() }).loose(),
  startedAt: isoDateTime.optional(),
  finishedAt: isoDateTime.optional(),
  durationMs: z.number().optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

/** The runtime schedule owned by a source (`workflow_schedules`), as embedded in the source detail. */
export const sourceScheduleDto = z
  .object({
    _id: z.string(),
    workflowKey: z.string(),
    enabled: z.boolean(),
    cron: z.string().optional(),
    intervalMinutes: z.number().int().optional(),
    timezone: z.string(),
    nextFireAt: isoDateTime.optional(),
    lastFiredAt: isoDateTime.optional(),
    lastRunId: z.string().optional(),
  })
  .loose();

const sourceRefDto = z.object({
  _id: z.string(),
  key: z.string(),
  name: z.string(),
  authority: z.object({ tier: z.enum(AUTHORITY_TIERS) }).loose(),
});

// ------------------------------------------------------------------ companies

export const companyListResponseDto = pageDto(companyDto);

export const companyDetailResponseDto = z.object({
  company: companyDto,
  survivor: companyDto.nullable(),
  observations: z.array(companyObservationDto),
  observationSources: z.array(sourceRefDto),
  jobs: z.array(jobListDocDto),
  jobSources: z.array(sourceDto),
  reviews: z.array(reviewItemDto),
  audit: z.array(auditEventDto),
});

export const companyReconcileResponseDto = z.object({ companyId: z.string(), changed: z.boolean() });

// ------------------------------------------------------------------ jobs

export const jobListItemDto = jobListDocDto.extend({ companyName: z.string().nullable() });
export const jobListResponseDto = pageDto(jobListItemDto);

export const jobDetailResponseDto = z.object({
  job: jobDto,
  /** Set when `job.status === 'merged'`: the job it was merged into (follows mergedInto, ≤ 10 hops; M7.6). */
  survivor: jobDto.nullable(),
  company: z.object({
    _id: z.string(),
    name: z.string().nullable(),
    domain: z.string().nullable(),
    sponsorship: (companyDto.shape.employment as AnyObject).shape.sponsorship as AnyObject,
  }),
  observations: z.array(jobObservationDto),
  sources: z.array(sourceRefDto.extend({ provider: z.string() })),
  verifications: z.array(jobVerificationDto),
  reviews: z.array(reviewItemDto),
  audit: z.array(auditEventDto),
});

// ------------------------------------------------------------------ observations

export const observationResponseDto = z.union([
  z.object({
    observation: z.union([companyObservationDto, jobObservationDto]),
    kind: z.enum(['company', 'job']),
    source: sourceRefDto.nullable(),
  }),
  z.strictObject({ observation: z.null() }),
]);

// ------------------------------------------------------------------ sources

/**
 * A source's schedule config with the scheduler's live state; `null` for upload-only sources and
 * sources with no schedule or no scheduler entry.
 */
export const sourceScheduleStateDto = z.object({
  cron: z.string().optional(),
  intervalMinutes: z.number().int().optional(),
  timezone: z.string(),
  enabled: z.boolean(),
  nextRunAt: isoDateTime.nullable(),
  lastFiredAt: isoDateTime.nullable(),
  backoffUntil: isoDateTime.nullable(),
});

/** The v1 list: list rows carry schedule state (OPS-1), `null` when there is no schedule. */
export const sourceListResponseDto = pageDto(
  sourceDto.extend({ schedule: sourceScheduleStateDto.nullable() }),
);

/** A source as list v2 and the detail return it (M7.4): server-computed freshness and company name. */
export const sourceListItemDto = sourceDto.extend({
  freshnessState: z.enum(SOURCE_FRESHNESS_STATES),
  freshnessAgeMs: z.number().int().nullable(),
  companyName: z.string().nullable(),
  schedule: sourceScheduleStateDto.nullable(),
});

export const sourceDetailResponseDto = z.object({
  source: sourceListItemDto,
  runs: z.array(runSummaryDto),
  snapshots: z.array(snapshotDto),
  schedule: sourceScheduleDto.nullable(),
  openReviews: z.array(reviewItemDto),
  audit: z.array(auditEventDto),
});

export const sourceRegisterResponseDto = z.object({ source: sourceDto, created: z.boolean() });
export const sourceResponseDto = z.object({ source: sourceDto });
export const snapshotUploadResponseDto = z.object({
  snapshotId: z.string(),
  artifactId: z.string(),
  unchanged: z.boolean(),
  runId: z.string().nullable(),
});

// ------------------------------------------------------------------ review

export const reviewListResponseDto = pageDto(reviewItemDto);

/** A field `correct` may set, with its editor descriptor and its current fact as a `SummaryFact` (M7.5). */
export const correctableFieldDto = z.strictObject({
  field: z.string(),
  path: z.string(),
  type: z.enum(['enum', 'string', 'object']),
  values: z.array(z.string()).optional(),
  schema: z.enum(['remoteScope', 'sponsorship', 'compensation']).optional(),
  targeted: z.boolean(),
  current: summaryFactDto(z.unknown()),
});

/**
 * A review item with its server-computed state and correctable fields (M7.5). `supportedActions`
 * is present on list rows only with `include=actions`; `null` = the probes failed transiently.
 */
export const reviewListItemDto = reviewItemDto.extend({
  queueState: z.enum(REVIEW_QUEUE_STATES),
  supportedActions: z.array(z.enum(REVIEW_ACTIONS)).nullable().optional(),
  correctable: z.array(correctableFieldDto),
  targetFields: z.array(z.string()),
});

/** The detail's item: `supportedActions` is always computed (`null` = the probes failed transiently). */
export const reviewDetailItemDto = reviewListItemDto.extend({
  supportedActions: z.array(z.enum(REVIEW_ACTIONS)).nullable(),
});

const countsDto = z.record(z.string(), z.number().int().min(0));
export const reviewListV2ResponseDto = listPageDto(reviewListItemDto).extend({
  facets: z.strictObject({ type: countsDto, severity: countsDto }).optional(),
});

const candidateDto = (reviewItemDto.shape.candidates as z.ZodArray<AnyObject>).element;
const projectedCompanyDto = companyDto.pick({
  _id: true,
  identity: true,
  geography: true,
  employment: true,
  quality: true,
});
const projectedJobDto = jobDto.pick({
  _id: true,
  identity: true,
  geography: true,
  lifecycle: true,
  sourceRefs: true,
});

export const reviewDetailResponseDto = z.object({
  item: reviewDetailItemDto,
  entity: z.union([companyDto, jobDto, sourceDto]).nullable(),
  observations: z.array(z.union([companyObservationDto, jobObservationDto])),
  candidates: z.array(
    candidateDto.extend({ entity: z.union([projectedCompanyDto, projectedJobDto]).nullable() }),
  ),
  audit: z.array(auditEventDto),
  /** The full facts (with evidence) of the fields the item targets (M7.5). */
  targetedFacts: z.array(
    z.object({
      field: z.string(),
      path: z.string(),
      fact: z
        .object({
          value: z.unknown(),
          status: z.string(),
          confidence: z.object({ level: z.string() }).loose(),
        })
        .loose()
        .nullable(),
    }),
  ),
});

export const reviewResolveResponseDto = z.object({ item: reviewItemDto });

/** `POST /api/review/:id/claim` and `/release` (API-9): the item with its triage `assignment` (absent after release). */
export const reviewTriageResponseDto = z.object({ item: reviewItemDto });

// ------------------------------------------------------------------ misc

/** Every Market action that starts a workflow: 202 `{ runId }`. */
export const runStartedResponseDto = z.object({ runId: z.string() });
export const auditListResponseDto = z.object({ items: z.array(auditEventDto) });
export const signalListResponseDto = pageDto(signalDto);

/** The error envelope (`apps/admin/lib/api-server/errors.ts`). */
export const errorResponseDto = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    issues: z.array(z.unknown()).max(20).optional(),
    requestId: z.string().optional(),
  }),
});
