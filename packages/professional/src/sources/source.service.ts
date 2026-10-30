import type { Collection, Filter } from 'mongodb';
import { z } from 'zod';
import { type Actor, contentHash, deterministicId, newId } from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError, validateDocument, withTransaction } from '@aptamind/db';
import { notFound, ProfessionalError } from '../api/errors';
import { type CursorPage, cursorQuery, pageParamsShape, toPage } from '../api/pagination';
import type { ProfessionalContext } from '../context';
import { urlSchema } from '../contracts/values';
import type { EventStore } from '../events/event.store';
import { type ExtractionDoc, extractionsCollection } from '../extraction/extraction.schema';
import { type ReviewItemDoc, reviewItemsCollection } from '../review/review.schema';
import type { SubjectService } from '../subjects/subject.service';
import { isLinkedInUrl } from './linkedin';
import { GITHUB_API_HOST, GITHUB_HANDLE_PATTERN, normalizeSourceUrl, SOURCE_KIND_POLICIES } from './policies';
import {
  MAX_IDEMPOTENCY_BINDINGS,
  SOURCE_ACQUISITION,
  SOURCE_KINDS,
  SOURCE_SCHEMA_VERSION,
  SOURCE_STATUSES,
  type SnapshotDoc,
  snapshotsCollection,
  type SourceDoc,
  sourcesCollection,
} from './source.schema';

/** `POST /api/professional/subjects/:id/sources` body (R-2). */
export const registerSourceInputSchema = z.strictObject({
  kind: z.enum(SOURCE_KINDS),
  /** Defaults to the kind's first allowed acquisition. */
  acquisition: z.enum(SOURCE_ACQUISITION).optional(),
  /** The stated URL of a fetched portfolio / personal website. */
  url: urlSchema.optional(),
  /** The stated GitHub handle of a `github` source. */
  handle: z.string().regex(GITHUB_HANDLE_PATTERN, { message: 'invalid GitHub handle' }).optional(),
  /** Page limit for documents/fetches from this source (≤ the platform limit). */
  maxPages: z.number().int().positive().optional(),
});
export type RegisterSourceInput = z.infer<typeof registerSourceInputSchema>;

/** `GET /api/professional/subjects/:id/sources` query: filters and page parameters; unknown keys → 400. */
export const listSourcesQuerySchema = z.strictObject({
  kind: z.enum(SOURCE_KINDS).optional(),
  status: z.enum(SOURCE_STATUSES).optional(),
  ...pageParamsShape,
});
export type ListSourcesQuery = z.infer<typeof listSourcesQuerySchema>;

export interface SourceDetail {
  source: SourceDoc;
  snapshots: SnapshotDoc[];
  extractions: ExtractionDoc[];
  openReviewItems: ReviewItemDoc[];
}

const invalid = (field: string, message: string) =>
  new ProfessionalError('validation_failed', message, { field });

/**
 * Subject-scoped sources (R-2): typed by kind, with authorship and acquisition policy. The same
 * external source (subject, kind, normalized URL/handle) registers once; an Idempotency-Key
 * makes any registration replayable. LinkedIn is import-only (PL-11). Archived subjects accept
 * no new sources — enforced inside the registering transaction, which increments the subject's
 * `sourceCount` under `status: active`, so a concurrent archive cannot interleave.
 */
export class SourceService {
  readonly col: Collection<SourceDoc>;
  readonly snapshots: Collection<SnapshotDoc>;
  readonly extractions: Collection<ExtractionDoc>;
  readonly reviews: Collection<ReviewItemDoc>;

  constructor(
    private readonly ctx: ProfessionalContext,
    private readonly subjects: SubjectService,
    private readonly events: EventStore,
  ) {
    this.col = getCollection(ctx.db, sourcesCollection);
    this.snapshots = getCollection(ctx.db, snapshotsCollection);
    this.extractions = getCollection(ctx.db, extractionsCollection);
    this.reviews = getCollection(ctx.db, reviewItemsCollection);
  }

  async register(
    subjectId: string,
    input: RegisterSourceInput,
    actor: Actor,
    idempotencyKey?: string,
  ): Promise<{ source: SourceDoc; created: boolean }> {
    const parsed = registerSourceInputSchema.parse(input);
    const plan = this.plan(parsed);
    const keyId = idempotencyKey ? deterministicId('psrc', subjectId, 'idem', idempotencyKey) : undefined;
    // The hash covers what the registration means, not how it was spelled (normalized URL or
    // handle, resolved acquisition and page limit).
    const requestHash = contentHash({
      subjectId,
      kind: parsed.kind,
      acquisition: plan.acquisition,
      externalRefKey: plan.externalRefKey ?? null,
      maxPages: plan.maxPages,
    });
    // A key replay returns the source it produced or was bound to — also after an archive.
    if (keyId) {
      const replay = await this.findByKey(subjectId, keyId, requestHash);
      if (replay) return { source: replay, created: false };
    }

    const subject = await this.subjects.get(subjectId);
    if (subject.status !== 'active')
      throw new ProfessionalError('subject_archived', 'Subject is archived', { id: subjectId });

    const _id = keyId ?? newId('psrc');
    const now = this.ctx.clock.now();
    const actorRef = { kind: actor.kind, id: actor.id };
    const doc = validateDocument(sourcesCollection, {
      _id,
      subjectId,
      kind: parsed.kind,
      authorship: SOURCE_KIND_POLICIES[parsed.kind].authorship,
      acquisition: plan.acquisition,
      ...(plan.externalRefKey ? { externalRefKey: plan.externalRefKey } : {}),
      ...(plan.url ? { url: plan.url } : {}),
      policy: { hostScope: plan.hostScope, maxPages: plan.maxPages },
      ownership: { state: plan.ownership },
      status: 'active',
      stats: { snapshots: 0, observations: 0 },
      health: { state: 'unknown', consecutiveFailures: 0 },
      createRequestHash: requestHash,
      createdBy: actorRef,
      schemaVersion: SOURCE_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    });

    try {
      await withTransaction(this.ctx.db.client, async (session) => {
        const fenced = await this.subjects.col.updateOne(
          { _id: subjectId, status: 'active' },
          { $inc: { sourceCount: 1 } },
          { session },
        );
        if (!fenced.matchedCount)
          throw new ProfessionalError('subject_archived', 'Subject is archived', { id: subjectId });
        await this.col.insertOne(doc, { session });
        await this.events.append(
          `${_id}:register`,
          [
            {
              subjectId,
              entity: { kind: 'source', id: _id },
              type: 'source.registered',
              to: 'active',
              reason: `kind_${parsed.kind}`,
            },
          ],
          actor,
          session,
        );
      });
      return { source: doc, created: true };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      if (keyId) {
        const replay = await this.findByKey(subjectId, keyId, requestHash);
        if (replay) return { source: replay, created: false };
      }
      if (doc.externalRefKey) {
        const existing = await this.col.findOne({
          subjectId,
          kind: doc.kind,
          externalRefKey: doc.externalRefKey,
        });
        if (existing) {
          const source = keyId ? await this.bindKey(existing, keyId, requestHash) : existing;
          return { source, created: false };
        }
      }
      throw err;
    }
  }

  /**
   * The source an Idempotency-Key created (`_id`) or was bound to; refuses the key when it was
   * used with another request (409 `idempotency_key_reused`).
   */
  private async findByKey(subjectId: string, keyId: string, requestHash: string): Promise<SourceDoc | null> {
    const doc = await this.col.findOne({
      subjectId,
      $or: [{ _id: keyId }, { 'idempotencyBindings.keyId': keyId }],
    });
    if (!doc) return null;
    const bound =
      doc._id === keyId
        ? doc.createRequestHash
        : doc.idempotencyBindings?.find((b) => b.keyId === keyId)?.requestHash;
    if (bound !== requestHash)
      throw new ProfessionalError(
        'idempotency_key_reused',
        'Idempotency-Key was used with a different request',
      );
    return doc;
  }

  /** Binds a key to the source its request matched by natural key, so later replays find it. */
  private async bindKey(existing: SourceDoc, keyId: string, requestHash: string): Promise<SourceDoc> {
    await this.col.updateOne(
      { _id: existing._id, 'idempotencyBindings.keyId': { $ne: keyId } },
      {
        $push: {
          idempotencyBindings: { $each: [{ keyId, requestHash }], $slice: -MAX_IDEMPOTENCY_BINDINGS },
        },
      },
    );
    // Re-read: a concurrent use of the same key with another body may have bound first.
    return (await this.findByKey(existing.subjectId, keyId, requestHash)) ?? existing;
  }

  async get(id: string): Promise<SourceDoc> {
    const s = await this.col.findOne({ _id: id });
    if (!s) throw notFound('source', id);
    return s;
  }

  async list(
    subjectId: string,
    query: z.input<typeof listSourcesQuerySchema>,
  ): Promise<CursorPage<SourceDoc>> {
    const q = listSourcesQuerySchema.parse(query);
    await this.subjects.get(subjectId);
    const filter: Filter<SourceDoc> = { subjectId };
    if (q.kind) filter.kind = q.kind;
    if (q.status) filter.status = q.status;
    const { after, sort } = cursorQuery(q);
    const docs = await this.col
      .find({ ...filter, ...after } as Filter<SourceDoc>)
      .sort(sort)
      .limit(q.limit + 1)
      .toArray();
    return toPage(docs, q.limit);
  }

  /** Source with its latest snapshots, extractions and open data-quality items (≤ 10 each). */
  async detail(id: string): Promise<SourceDetail> {
    const source = await this.get(id);
    const [snapshots, extractions, openReviewItems] = await Promise.all([
      this.snapshots.find({ sourceId: id }).sort({ sourceAsOf: -1 }).limit(10).toArray(),
      this.extractions.find({ sourceId: id }).sort({ createdAt: -1 }).limit(10).toArray(),
      this.reviews
        .find({ subjectId: source.subjectId, status: 'open', 'entity.kind': 'source', 'entity.id': id })
        .sort({ priority: -1, createdAt: 1 })
        .limit(10)
        .toArray(),
    ]);
    return { source, snapshots, extractions, openReviewItems };
  }

  /** Applies the kind policy: acquisition, reference, host scope, ownership, page limit. */
  private plan(input: RegisterSourceInput) {
    const policy = SOURCE_KIND_POLICIES[input.kind];
    if (input.url && isLinkedInUrl(input.url))
      throw new ProfessionalError('linkedin_import_only', 'LinkedIn is import-only', { field: 'url' });
    const acquisition = input.acquisition ?? policy.acquisitions[0]!;
    if (!policy.acquisitions.includes(acquisition)) {
      if (input.kind === 'linkedin_export')
        throw new ProfessionalError('linkedin_import_only', 'LinkedIn is import-only', {
          field: 'acquisition',
        });
      throw invalid('acquisition', `acquisition not allowed for kind ${input.kind}`);
    }
    const maxLimit = this.ctx.config.limits.maxDocumentPages;
    if (input.maxPages !== undefined && input.maxPages > maxLimit)
      throw invalid('maxPages', 'maxPages above the limit');
    const maxPages = input.maxPages ?? maxLimit;
    const fetch = acquisition === 'fetch';
    const wantsUrl = fetch && policy.reference === 'url';
    const wantsHandle = fetch && policy.reference === 'github_handle';
    if (wantsUrl && !input.url) throw invalid('url', 'url required');
    if (!wantsUrl && input.url) throw invalid('url', `url not accepted for ${input.kind} (${acquisition})`);
    if (wantsHandle && !input.handle) throw invalid('handle', 'handle required');
    if (!wantsHandle && input.handle) throw invalid('handle', `handle not accepted for ${input.kind}`);

    if (wantsUrl) {
      const url = normalizeSourceUrl(input.url!);
      return {
        acquisition,
        url,
        externalRefKey: `url:${url}`,
        hostScope: [new URL(url).hostname],
        ownership: policy.fetchedOwnership,
        maxPages,
      };
    }
    if (wantsHandle) {
      const handle = input.handle!.toLowerCase();
      return {
        acquisition,
        url: `https://github.com/${handle}`,
        externalRefKey: `github:${handle}`,
        hostScope: [GITHUB_API_HOST],
        ownership: policy.fetchedOwnership,
        maxPages,
      };
    }
    return {
      acquisition,
      url: undefined,
      externalRefKey: undefined,
      hostScope: [] as string[],
      ownership: 'intrinsic' as const,
      maxPages,
    };
  }
}
