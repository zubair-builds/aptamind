import type { Collection, Filter } from 'mongodb';
import { z } from 'zod';
import { getCollection } from '@aptamind/db';
import { notFound } from '../api/errors';
import { type CursorPage, cursorQuery, pageParamsShape, toPage } from '../api/pagination';
import type { ProfessionalContext } from '../context';
import { CLAIM_TYPE_DEFS, CLAIM_TYPES, type ClaimType } from '../contracts/claims';
import { idSchema } from '../contracts/ids';
import type { SubjectService } from '../subjects/subject.service';
import { OBSERVATION_STATUSES, type ObservationDoc, observationsCollection } from './observation.schema';

/**
 * Sensitive claim types (`sensitivity: sensitive`: current location, work authorization incl.
 * visa type, relocation, compensation, career preference) are private by default (supervisor
 * ruling, P1.3): excluded from evidence lists and hidden like unknown ids unless the request says
 * `include=sensitive`.
 */
export const SENSITIVE_CLAIM_TYPES: readonly ClaimType[] = CLAIM_TYPES.filter(
  (t) => CLAIM_TYPE_DEFS[t].sensitivity === 'sensitive',
);
export const isSensitiveClaimType = (t: ClaimType) => SENSITIVE_CLAIM_TYPES.includes(t);

/** `[claimType, field]` pairs of sensitive fields of non-sensitive claim types (`sensitiveFields`). */
const SENSITIVE_FIELDS: ReadonlyArray<readonly [ClaimType, string]> = CLAIM_TYPES.flatMap((t) =>
  (CLAIM_TYPE_DEFS[t].sensitiveFields ?? []).map((f) => [t, f] as const),
);

/**
 * Whether an observation is private by default: a sensitive claim type, or a value carrying a
 * sensitive field (e.g. `preference.remote.timezoneWindow`).
 */
export function isSensitiveObservation(o: Pick<ObservationDoc, 'claimType' | 'payload'>): boolean {
  if (isSensitiveClaimType(o.claimType)) return true;
  const payload = (o.payload ?? {}) as Record<string, unknown>;
  return (CLAIM_TYPE_DEFS[o.claimType].sensitiveFields ?? []).some((f) => payload[f] != null);
}

/** The list filter equivalent of `!isSensitiveObservation`. */
function nonSensitiveFilter(): Filter<ObservationDoc> {
  return {
    $nor: [
      { claimType: { $in: [...SENSITIVE_CLAIM_TYPES] } },
      ...SENSITIVE_FIELDS.map(([claimType, f]) => ({ claimType, [`payload.${f}`]: { $ne: null } })),
    ],
  } as Filter<ObservationDoc>;
}

/** `include=sensitive` opt-in, shared by the Professional routes that can return sensitive values. */
export const includeSensitiveSchema = z.enum(['sensitive']).optional();

/** `GET /api/professional/subjects/:id/observations` query (strict; list conventions). */
export const listObservationsQuerySchema = z
  .strictObject({
    sourceId: idSchema('source').optional(),
    snapshotId: idSchema('snapshot').optional(),
    claimType: z.enum(CLAIM_TYPES as [ClaimType, ...ClaimType[]]).optional(),
    status: z.enum(OBSERVATION_STATUSES).optional(),
    include: includeSensitiveSchema,
    ...pageParamsShape,
  })
  .refine((q) => !(q.claimType && isSensitiveClaimType(q.claimType) && q.include !== 'sensitive'), {
    message: 'sensitive claim type requires include=sensitive',
    path: ['claimType'],
  });

/** `GET /api/professional/observations/:id` query. */
export const getObservationQuerySchema = z.strictObject({ include: includeSensitiveSchema });

/** Read access to observations (evidence) for the operator views; observations are append-only. */
export class ObservationService {
  readonly col: Collection<ObservationDoc>;

  constructor(
    ctx: ProfessionalContext,
    private readonly subjects: SubjectService,
  ) {
    this.col = getCollection(ctx.db, observationsCollection);
  }

  /** A sensitive observation without `include=sensitive` is answered exactly like an unknown id. */
  async get(id: string, opts: { includeSensitive?: boolean } = {}): Promise<ObservationDoc> {
    const o = await this.col.findOne({ _id: id });
    if (!o || (isSensitiveObservation(o) && !opts.includeSensitive)) throw notFound('observation', id);
    return o;
  }

  async list(
    subjectId: string,
    query: z.input<typeof listObservationsQuerySchema>,
  ): Promise<CursorPage<ObservationDoc>> {
    const q = listObservationsQuerySchema.parse(query);
    await this.subjects.get(subjectId);
    const filter: Filter<ObservationDoc> = { subjectId };
    if (q.sourceId) filter.sourceId = q.sourceId;
    if (q.snapshotId) filter.snapshotId = q.snapshotId;
    if (q.claimType) filter.claimType = q.claimType;
    if (q.include !== 'sensitive') Object.assign(filter, nonSensitiveFilter());
    if (q.status) filter.status = q.status;
    const { after, sort } = cursorQuery(q);
    const docs = await this.col
      .find({ ...filter, ...after } as Filter<ObservationDoc>)
      .sort(sort)
      .limit(q.limit + 1)
      .toArray();
    return toPage(docs, q.limit);
  }
}
