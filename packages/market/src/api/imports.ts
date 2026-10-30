import { z } from 'zod';
import { actorSchema } from '@aptamind/contracts';
import { IMPORT_STATUSES, IMPORT_TYPES } from '../imports/import.schema';
import { cursorParam } from './list';
import { idParam } from './query';
import { isoDateTime } from './wire';

/** `POST /api/imports`: the body is the file; these say where it goes. */
export const importCreateQuerySchema = z.strictObject({
  type: z.enum(IMPORT_TYPES),
  sourceId: idParam,
  fileName: z.string().max(1000).optional(),
});

/** `GET /api/imports`: newest first, cursor-paginated (market-imports.md). */
export const importListQuerySchema = z.strictObject({
  type: z.enum(IMPORT_TYPES).optional(),
  status: z.enum(IMPORT_STATUSES).optional(),
  sourceId: idParam.optional(),
  cursor: cursorParam.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const count = z.number().int().nullable();

/** An import without its trace (the list row). */
export const importSummaryDto = z.object({
  _id: z.string(),
  type: z.enum(IMPORT_TYPES),
  fileName: z.string(),
  contentType: z.string(),
  bytes: z.number().int(),
  contentHash: z.string(),
  artifactId: z.string(),
  snapshotId: z.string(),
  snapshotUnchanged: z.boolean(),
  sourceId: z.string(),
  runId: z.string().nullable(),
  createdBy: actorSchema,
  createdAt: isoDateTime,
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  source: z.object({ id: z.string(), name: z.string(), provider: z.string() }),
  status: z.enum(IMPORT_STATUSES),
  startedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
  counts: z.object({
    rows: count,
    parsed: count,
    accepted: count,
    created: count,
    updated: count,
    unchanged: count,
    ignored: count,
    failed: count,
    reviews: count,
    warnings: count,
  }),
});

export const importDetailDto = importSummaryDto.extend({
  trace: z.object({
    runId: z.string().nullable(),
    snapshotId: z.string(),
    artifactId: z.string(),
    reportArtifactId: z.string().nullable(),
    reviewIds: z.array(z.string()),
    companyIds: z.array(z.string()),
    sourceIds: z.array(z.string()),
    truncated: z.boolean(),
  }),
});

export const importListDto = z.object({
  items: z.array(importSummaryDto),
  nextCursor: z.string().nullable(),
});
