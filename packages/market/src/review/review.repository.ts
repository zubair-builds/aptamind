import type { Filter } from 'mongodb';
import { type JsonObject, newId, NotFoundError, type Page, SYSTEM_ACTOR } from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError, validateDocument } from '@aptamind/db';
import type { EvidenceReference } from '@aptamind/provenance';
import type { MarketContext } from '../context';
import {
  REVIEW_SCHEMA_VERSION,
  type ReviewAction,
  type ReviewItemDoc,
  reviewItemsCollection,
  type ReviewType,
} from './schemas';

const SEVERITY_PRIORITY = { high: 300, medium: 200, low: 100 } as const;

export interface RaiseReviewInput {
  type: ReviewType;
  severity: 'low' | 'medium' | 'high';
  dedupeKey: string;
  entity: ReviewItemDoc['entity'];
  subject: string;
  reason: string;
  evidence?: EvidenceReference[];
  candidates?: ReviewItemDoc['candidates'];
  observationIds?: string[];
  context?: JsonObject;
  allowedActions: ReviewAction[];
  priorityBoost?: number;
  /**
   * Re-raising onto an open item with `refresh` replaces its `subject`, `reason`, `severity` (and
   * priority), `context`, `allowedActions` and — when given — `evidence` and `observationIds` with
   * this raise's (the latest occurrence is what an operator decides on: e.g. a snapshot's import
   * report) — unless the item is being resolved (claimed), whose decision was made on what the
   * operator saw.
   */
  refresh?: boolean;
}

/**
 * Review item persistence. `raise` is idempotent on `dedupeKey`: re-raising the same question
 * (e.g. on a retried import) increments `occurrences` and attaches new observation ids
 * instead of creating a duplicate item.
 */
export class ReviewRepository {
  constructor(private readonly ctx: MarketContext) {}

  get col() {
    return getCollection(this.ctx.db, reviewItemsCollection);
  }

  async raise(input: RaiseReviewInput): Promise<{ item: ReviewItemDoc; created: boolean }> {
    const now = this.ctx.clock.now();
    const context = JSON.parse(JSON.stringify(input.context ?? {})) as JsonObject;
    for (let i = 0; i < 3; i++) {
      if (input.refresh) {
        const refreshed = await this.col.findOneAndUpdate(
          { dedupeKey: input.dedupeKey, status: 'open', claim: { $exists: false } },
          {
            $inc: { occurrences: 1 },
            // What the operator is shown refreshes together with the context (its evidence
            // digest), so a decision always covers the evidence it was shown (bc013e8 M2).
            $set: {
              subject: input.subject,
              reason: input.reason,
              severity: input.severity,
              priority: SEVERITY_PRIORITY[input.severity] + (input.priorityBoost ?? 0),
              context,
              allowedActions: input.allowedActions,
              updatedAt: now,
              ...(input.evidence ? { evidence: input.evidence } : {}),
              ...(input.observationIds ? { observationIds: input.observationIds } : {}),
            },
          },
          { returnDocument: 'after' },
        );
        if (refreshed) return { item: refreshed, created: false };
      }
      const existing = await this.col.findOneAndUpdate(
        { dedupeKey: input.dedupeKey, status: 'open' },
        {
          $inc: { occurrences: 1 },
          $addToSet: { observationIds: { $each: input.observationIds ?? [] } },
          $set: { updatedAt: now },
        },
        { returnDocument: 'after' },
      );
      if (existing) return { item: existing, created: false };
      const doc: ReviewItemDoc = {
        _id: newId('rev'),
        type: input.type,
        severity: input.severity,
        priority: SEVERITY_PRIORITY[input.severity] + (input.priorityBoost ?? 0),
        status: 'open',
        dedupeKey: input.dedupeKey,
        entity: input.entity,
        subject: input.subject,
        reason: input.reason,
        evidence: input.evidence ?? [],
        candidates: input.candidates ?? [],
        observationIds: input.observationIds ?? [],
        context,
        allowedActions: input.allowedActions,
        occurrences: 1,
        schemaVersion: REVIEW_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.col.insertOne(validateDocument(reviewItemsCollection, doc));
        return { item: doc, created: true };
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
    }
    throw new Error(`Could not raise review ${input.dedupeKey}`);
  }

  /**
   * Close the open item with `dedupeKey` because the question no longer arises (a later run
   * answered it). Never touches an item that is being resolved by an operator (`claim` set).
   * Returns the closed item, or null when there was nothing open to close.
   */
  async resolveObsolete(
    dedupeKey: string,
    reason: string,
    result: JsonObject,
  ): Promise<ReviewItemDoc | null> {
    const now = this.ctx.clock.now();
    return this.col.findOneAndUpdate(
      { dedupeKey, status: 'open', claim: { $exists: false } },
      {
        $set: {
          status: 'resolved',
          resolution: {
            action: 'retry',
            reason,
            actor: { kind: SYSTEM_ACTOR.kind, id: SYSTEM_ACTOR.id },
            at: now,
            result,
          },
          updatedAt: now,
        },
        $unset: { assignment: '' },
      },
      { returnDocument: 'after' },
    );
  }

  async get(id: string): Promise<ReviewItemDoc> {
    const doc = await this.col.findOne({ _id: id });
    if (!doc) throw new NotFoundError('ReviewItem', id);
    return doc;
  }

  async list(q: {
    status?: string;
    type?: string;
    entityId?: string;
    limit: number;
    offset: number;
  }): Promise<Page<ReviewItemDoc>> {
    const filter: Filter<ReviewItemDoc> = {};
    if (q.status) filter.status = q.status as ReviewItemDoc['status'];
    if (q.type) filter.type = q.type as ReviewType;
    if (q.entityId) filter.$or = [{ 'entity.id': q.entityId }, { 'candidates.id': q.entityId }];
    const sort: Record<string, 1 | -1> =
      q.status === 'open' || !q.status ? { priority: -1, createdAt: 1 } : { updatedAt: -1 };
    const [items, total] = await Promise.all([
      this.col.find(filter).sort(sort).skip(q.offset).limit(q.limit).toArray(),
      this.col.countDocuments(filter),
    ]);
    return { items, total, limit: q.limit, offset: q.offset };
  }

  /**
   * The operator's standing confirmation of the question `dedupeKey` about `entity` (its premise
   * was accepted, e.g. "the listing really shrank"): the latest item on the key that was
   * resolved with `confirm`, unless a later item on the same key was `dismiss`ed — a later
   * dismissal revokes it (A-L6). Null when there is none.
   */
  async latestConfirmation(
    dedupeKey: string,
    entity: ReviewItemDoc['entity'],
  ): Promise<ReviewItemDoc | null> {
    const latest = await this.latestDecision(dedupeKey, entity);
    return latest?.resolution?.action === 'confirm' ? latest : null;
  }

  /**
   * The latest item on `dedupeKey` about `entity` closed with `confirm` or `dismiss`, or null.
   * `excludeActorIds`: decisions by these actors (e.g. a system supersession) do not count.
   */
  latestDecision(
    dedupeKey: string,
    entity: ReviewItemDoc['entity'],
    opts: { excludeActorIds?: string[] } = {},
  ): Promise<ReviewItemDoc | null> {
    const { filter, sort } = latestDecisionQuery(dedupeKey, entity, opts);
    return this.col.find(filter).sort(sort).limit(1).next();
  }

  countOpenForEntity(entityId: string): Promise<number> {
    return this.col.countDocuments({
      status: 'open',
      $or: [{ 'entity.id': entityId }, { 'candidates.id': entityId }],
    });
  }
}

/**
 * The latest confirm/dismiss decision on `dedupeKey` about `entity`. Led by the entity so it is
 * served by the `by_entity` index ({entity.kind, entity.id, status}); the key and action are
 * residual filters over that one entity's closed items.
 */
export function latestDecisionQuery(
  dedupeKey: string,
  entity: ReviewItemDoc['entity'],
  opts: { excludeActorIds?: string[] } = {},
): { filter: Filter<ReviewItemDoc>; sort: Record<string, 1 | -1> } {
  return {
    filter: {
      'entity.kind': entity.kind,
      'entity.id': entity.id,
      status: { $in: ['resolved', 'dismissed'] },
      dedupeKey,
      'resolution.action': { $in: ['confirm', 'dismiss'] },
      ...(opts.excludeActorIds?.length ? { 'resolution.actor.id': { $nin: opts.excludeActorIds } } : {}),
    },
    sort: { 'resolution.at': -1, updatedAt: -1 },
  };
}
