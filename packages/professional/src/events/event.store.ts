import type { ClientSession, Collection } from 'mongodb';
import type { Actor } from '@aptamind/contracts';
import { deterministicId } from '@aptamind/contracts';
import { getCollection, validateDocument } from '@aptamind/db';
import type { ProfessionalContext } from '../context';
import { type EventDoc, type EventEntityKind, EVENT_SCHEMA_VERSION, eventsCollection } from './event.schema';

export interface NewEvent {
  subjectId: string;
  entity: { kind: EventEntityKind; id: string };
  type: string;
  from?: string;
  to?: string;
  reason: string;
  operationId?: string;
  runId?: string;
}

/**
 * The append-only Professional event ledger (R-23). Events are written in the transaction of
 * the change they record, with deterministic ids `det(operation, entity, seq)` and
 * `$setOnInsert`, so a retried transaction or replayed operation adds nothing.
 */
export class EventStore {
  readonly col: Collection<EventDoc>;

  constructor(private readonly ctx: ProfessionalContext) {
    this.col = getCollection(ctx.db, eventsCollection);
  }

  async append(operation: string, events: NewEvent[], actor: Actor, session?: ClientSession): Promise<void> {
    const now = this.ctx.clock.now();
    for (const [seq, e] of events.entries()) {
      const doc = validateDocument(eventsCollection, {
        _id: deterministicId('pevt', operation, e.entity.kind, e.entity.id, seq),
        subjectId: e.subjectId,
        entity: e.entity,
        type: e.type,
        ...(e.from !== undefined ? { from: e.from } : {}),
        ...(e.to !== undefined ? { to: e.to } : {}),
        reason: e.reason,
        actor: { kind: actor.kind, id: actor.id },
        ...(e.operationId ? { operationId: e.operationId } : {}),
        ...(e.runId ? { runId: e.runId } : {}),
        at: now,
        schemaVersion: EVENT_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
      });
      await this.col.updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true, session });
    }
  }

  /** An entity's or a subject's history, newest first. */
  async list(filter: { subjectId?: string; entity?: { kind: EventEntityKind; id: string } }, limit = 50) {
    const q: Record<string, unknown> = {};
    if (filter.subjectId) q.subjectId = filter.subjectId;
    if (filter.entity) {
      q['entity.kind'] = filter.entity.kind;
      q['entity.id'] = filter.entity.id;
    }
    return this.col.find(q).sort({ at: -1, _id: -1 }).limit(limit).toArray();
  }
}
