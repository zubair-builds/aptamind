import type { ClientSession } from 'mongodb';
import type { Actor, JsonObject } from '@aptamind/contracts';
import { deterministicId, newId } from '@aptamind/contracts';
import { getCollection } from '@aptamind/db';
import type { MarketContext } from '../context';
import { type AuditEventDoc, auditEventsCollection, REVIEW_SCHEMA_VERSION } from './schemas';

/** Id of an audit event recorded once per key, action and entity (see `AuditLog.record` `onceKey`). */
export function auditOnceId(onceKey: string, action: string, entity: { kind: string; id: string }): string {
  return deterministicId('aud', 'once', onceKey, action, entity.kind, entity.id);
}

export class AuditLog {
  constructor(private readonly ctx: MarketContext) {}

  private get col() {
    return getCollection(this.ctx.db, auditEventsCollection);
  }

  async record(
    e: {
      actor: Actor;
      action: string;
      entity: { kind: string; id: string };
      details?: JsonObject;
      reviewItemId?: string;
      runId?: string;
      /** Makes the event idempotent: the same key (and action/entity/details) records once. */
      idempotencyKey?: string;
      /**
       * Records the event once per key, action and entity, whatever the details: the first
       * writer wins (two concurrent runs may hold different details for one fact).
       */
      onceKey?: string;
    },
    /** Record inside the caller's transaction (e.g. a generation-fenced review effect). */
    opts: { session?: ClientSession } = {},
  ): Promise<AuditEventDoc> {
    const now = this.ctx.clock.now();
    const details = JSON.parse(JSON.stringify(e.details ?? {})) as JsonObject;
    // Events of a review decision are idempotent: a resumed resolution records the same event
    // once (same review item, action, entity and details → same id).
    const key = e.idempotencyKey ?? e.reviewItemId;
    const id = e.onceKey
      ? auditOnceId(e.onceKey, e.action, e.entity)
      : key
        ? deterministicId('aud', key, e.action, e.entity.kind, e.entity.id, JSON.stringify(details))
        : newId('aud');
    const doc: AuditEventDoc = {
      _id: id,
      at: now,
      actor: { kind: e.actor.kind, id: e.actor.id },
      action: e.action,
      entity: e.entity,
      reviewItemId: e.reviewItemId,
      runId: e.runId,
      details,
      schemaVersion: REVIEW_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    await this.col.updateOne(
      { _id: id },
      { $setOnInsert: doc },
      opts.session ? { upsert: true, session: opts.session } : { upsert: true },
    );
    return doc;
  }

  /** The event `record` wrote with this `onceKey`, or null. */
  findOnce(
    onceKey: string,
    action: string,
    entity: { kind: string; id: string },
  ): Promise<AuditEventDoc | null> {
    return this.col.findOne({ _id: auditOnceId(onceKey, action, entity) });
  }

  list(filter: { entityKind?: string; entityId?: string; reviewItemId?: string }, limit = 100) {
    const q: Record<string, unknown> = {};
    if (filter.entityKind) q['entity.kind'] = filter.entityKind;
    if (filter.entityId) q['entity.id'] = filter.entityId;
    if (filter.reviewItemId) q.reviewItemId = filter.reviewItemId;
    return this.col.find(q).sort({ at: -1 }).limit(limit).toArray();
  }
}
