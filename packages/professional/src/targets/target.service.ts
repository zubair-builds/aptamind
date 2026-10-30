import type { ClientSession, Collection, Filter } from 'mongodb';
import { z } from 'zod';
import { type Actor, canonicalJson, contentHash, deterministicId, newId } from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError, validateDocument, withTransaction } from '@aptamind/db';
import { notFound, ProfessionalError } from '../api/errors';
import { type CursorPage, cursorQuery, pageParamsSchema, pageParamsShape, toPage } from '../api/pagination';
import type { ProfessionalContext } from '../context';
import { idSchema } from '../contracts/ids';
import {
  emptyTargetViability,
  TARGET_STATUSES,
  targetFitSchema,
  type TargetSpec,
  targetSpecSchema,
  type TargetStatus,
  targetViabilitySchema,
} from '../contracts/targets';
import type { EventStore, NewEvent } from '../events/event.store';
import type { SubjectService } from '../subjects/subject.service';
import {
  type CareerTargetDoc,
  type CareerTargetVersionDoc,
  careerTargetsCollection,
  careerTargetVersionsCollection,
  MAX_TARGETS_PER_SUBJECT,
  TARGET_SCHEMA_VERSION,
  TARGET_VERSION_SCHEMA_VERSION,
  type TargetChangeKind,
} from './target.schema';
import {
  canEditTargetSpec,
  isRankedStatus,
  type TargetAction,
  targetActionTarget,
  targetActorClass,
  targetBasis,
} from './transitions';

/** `POST /api/professional/subjects/:id/targets` body. */
export const createTargetInputSchema = z.strictObject({
  label: targetSpecSchema.shape.label,
  fit: targetFitSchema,
  /** Sensitive; omitted = unknown (no geography, no constraints). */
  viability: targetViabilitySchema.optional(),
  rationale: targetSpecSchema.shape.rationale,
  /** `active` (default) or `paused`: a stated target that is not being pursued right now. */
  status: z.enum(['active', 'paused']).optional(),
});
export type CreateTargetInput = z.infer<typeof createTargetInputSchema>;

/** `PATCH /api/professional/targets/:id` body: each given part replaces the current one. */
export const editTargetInputSchema = z
  .strictObject({
    expectedRev: z.number().int().nonnegative(),
    label: targetSpecSchema.shape.label.optional(),
    fit: targetFitSchema.optional(),
    viability: targetViabilitySchema.optional(),
    /** `null` clears the rationale. */
    rationale: z.union([z.string().trim().min(1).max(2000), z.null()]).optional(),
  })
  .refine(
    (e) =>
      e.label !== undefined || e.fit !== undefined || e.viability !== undefined || e.rationale !== undefined,
    { message: 'nothing to update' },
  );
export type EditTargetInput = z.infer<typeof editTargetInputSchema>;

/** Body of the status actions (`activate`, `pause`, `archive`, `accept`, `decline`). */
export const targetActionInputSchema = z.strictObject({ expectedRev: z.number().int().nonnegative() });
export type TargetActionInput = z.infer<typeof targetActionInputSchema>;

/** `POST /api/professional/subjects/:id/targets/reorder` body: every ranked target, highest first. */
export const reorderTargetsInputSchema = z.strictObject({
  order: z
    .array(
      z.strictObject({ targetId: idSchema('careerTarget'), expectedRev: z.number().int().nonnegative() }),
    )
    .max(MAX_TARGETS_PER_SUBJECT)
    .refine((o) => new Set(o.map((x) => x.targetId)).size === o.length, { message: 'duplicate target' }),
});
export type ReorderTargetsInput = z.infer<typeof reorderTargetsInputSchema>;

/**
 * `GET /api/professional/subjects/:id/targets` query. Without `status` the open targets are listed
 * (`proposed`, `active`, `paused`: at most 100, not paginated). `status=archived|declined|all`
 * lists history with keyset cursor pagination over `(createdAt, _id)` (R-29).
 */
export const listTargetsQuerySchema = z
  .strictObject({
    status: z.enum([...TARGET_STATUSES, 'all']).optional(),
    limit: pageParamsShape.limit.unwrap().optional(),
    cursor: pageParamsShape.cursor,
    sort: pageParamsShape.sort.unwrap().optional(),
  })
  .refine(
    (q) =>
      PAGED_STATUSES.includes(q.status as (typeof PAGED_STATUSES)[number]) ||
      (q.limit === undefined && q.cursor === undefined && q.sort === undefined),
    { message: 'limit, cursor and sort apply to status=archived|declined|all only' },
  );

/** One message for both cap paths (create and re-open). */
const TARGET_LIMIT_MESSAGE = 'Too many open targets for this subject';

/** Statuses that count towards the per-subject cap and form the default list. */
export const OPEN_TARGET_STATUSES = ['proposed', 'active', 'paused'] as const;
/** Order of the open list: active, then paused (each by priority), then proposed (newest first). */
const OPEN_TARGET_STATUSES_ORDER = ['active', 'paused', 'proposed'] as const;
const isOpenStatus = (s: TargetStatus) => (OPEN_TARGET_STATUSES as readonly TargetStatus[]).includes(s);
const PAGED_STATUSES = ['archived', 'declined', 'all'] as const;

/** `GET /api/professional/targets/:id/versions` query: keyset over `version` (default 50). */
export const listTargetVersionsQuerySchema = z.strictObject({
  limit: z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[0-9]{1,3}$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(100))
    .default(50),
  cursor: z.string().max(200).optional(),
});

/**
 * Career targets (domain doc §9; R-25 … R-27; PL-5, PL-13).
 *
 * - A subject has any number of simultaneous targets; ranked ones (`active`, `paused`) are
 *   ordered by a unique `priority` (1 = highest).
 * - Every change bumps `rev` and `version` and inserts an immutable version document plus an
 *   event, all in one transaction guarded by the `rev` the caller saw (stale → 409, nothing
 *   written). History is never destroyed: nothing is deleted, archived targets stay readable.
 * - Every target transaction (create, edit, status change, reorder) first increments the
 *   subject's `targetsRev` under `status: active`, so concurrent ranking changes of one subject
 *   serialize (unique priorities) and an archived subject accepts no target changes.
 * - The subject's word outranks inference (`transitions.ts`): automation actors may only propose
 *   (P5.2) and never change what the subject stated or accepted.
 */
export class TargetService {
  readonly col: Collection<CareerTargetDoc>;
  readonly versions: Collection<CareerTargetVersionDoc>;

  constructor(
    private readonly ctx: ProfessionalContext,
    private readonly subjects: SubjectService,
    private readonly events: EventStore,
  ) {
    this.col = getCollection(ctx.db, careerTargetsCollection);
    this.versions = getCollection(ctx.db, careerTargetVersionsCollection);
  }

  /**
   * Creates a stated target. With an Idempotency-Key the id is `det(ptgt, subject, 'idem', key)`:
   * a replay returns the same target (`created: false`), the same key with another body is 409
   * `idempotency_key_reused`.
   */
  async create(
    subjectId: string,
    input: CreateTargetInput,
    actor: Actor,
    idempotencyKey?: string,
  ): Promise<{ target: CareerTargetDoc; created: boolean }> {
    const parsed = createTargetInputSchema.parse(input);
    const status = parsed.status ?? 'active';
    const actorClass = targetActorClass(actor);
    if (!targetActionTarget('create', null, actorClass))
      throw new ProfessionalError('illegal_transition', 'Only the subject can state a target', {
        action: 'create',
      });
    const spec = targetSpecSchema.parse({
      label: parsed.label,
      fit: parsed.fit,
      viability: parsed.viability ?? emptyTargetViability(),
      ...(parsed.rationale !== undefined ? { rationale: parsed.rationale } : {}),
    });
    const requestHash = contentHash({ subjectId, spec, status });
    const _id = idempotencyKey ? deterministicId('ptgt', subjectId, 'idem', idempotencyKey) : newId('ptgt');
    if (idempotencyKey) {
      const replay = await this.col.findOne({ _id });
      if (replay) return { target: this.checkReplay(replay, requestHash), created: false };
    }
    await this.subjects.get(subjectId);

    try {
      const target = await withTransaction(this.ctx.db.client, async (session) => {
        await this.fence(subjectId, session);
        // Only open targets count: archived and declined ones are history (a proposals cap is P5.2).
        const count = await this.col.countDocuments(
          { subjectId, status: { $in: [...OPEN_TARGET_STATUSES] } },
          { session },
        );
        if (count >= MAX_TARGETS_PER_SUBJECT)
          throw new ProfessionalError('target_limit_reached', TARGET_LIMIT_MESSAGE, {
            max: MAX_TARGETS_PER_SUBJECT,
          });
        const now = this.ctx.clock.now();
        const doc = validateDocument(careerTargetsCollection, {
          _id,
          subjectId,
          status,
          priority: await this.nextPriority(subjectId, session),
          spec,
          origin: 'stated',
          basis: targetBasis('stated'),
          rev: 0,
          version: 1,
          createRequestHash: requestHash,
          createdBy: { kind: actor.kind, id: actor.id },
          schemaVersion: TARGET_SCHEMA_VERSION,
          createdAt: now,
          updatedAt: now,
        });
        await this.col.insertOne(doc, { session });
        await this.writeVersion(doc, 'created', 'operator_stated', actor, session);
        await this.events.append(
          `${_id}:v1`,
          [
            {
              subjectId,
              entity: this.entity(_id),
              type: 'target.created',
              to: status,
              reason: 'operator_stated',
            },
          ],
          actor,
          session,
        );
        return doc;
      });
      return { target, created: true };
    } catch (err) {
      if (!isDuplicateKeyError(err) || !idempotencyKey) throw err;
      const existing = await this.col.findOne({ _id });
      if (!existing) throw err;
      return { target: this.checkReplay(existing, requestHash), created: false };
    }
  }

  async get(id: string): Promise<CareerTargetDoc> {
    const t = await this.col.findOne({ _id: id });
    if (!t) throw notFound('career_target', id);
    return t;
  }

  /**
   * A subject's targets. Default: the open ones — active and paused by priority, then proposed
   * (newest first); `status=` one open status narrows it. `status=archived|declined|all` pages
   * through history (newest first by default).
   */
  async list(
    subjectId: string,
    query: z.input<typeof listTargetsQuerySchema> = {},
  ): Promise<CursorPage<CareerTargetDoc>> {
    const q = listTargetsQuerySchema.parse(query);
    await this.subjects.get(subjectId);
    if (q.status === 'archived' || q.status === 'declined' || q.status === 'all') {
      const page = pageParamsSchema.parse({ limit: q.limit, cursor: q.cursor, sort: q.sort });
      const { after, sort } = cursorQuery(page);
      const docs = await this.col
        .find({
          subjectId,
          ...(q.status === 'all' ? {} : { status: q.status }),
          ...after,
        } as Filter<CareerTargetDoc>)
        .sort(sort)
        .limit(page.limit + 1)
        .toArray();
      return toPage(docs, page.limit);
    }
    return { items: await this.open(subjectId, q.status), nextCursor: null, limit: MAX_TARGETS_PER_SUBJECT };
  }

  /** The open targets (ranked by priority, then proposed), or those of one open status. */
  async open(subjectId: string, status?: TargetStatus): Promise<CareerTargetDoc[]> {
    // Sorted in the database before the limit, so a limit can never drop an arbitrary target.
    const docs = await this.col
      .aggregate<CareerTargetDoc & { _order: number }>([
        { $match: { subjectId, status: status ? status : { $in: [...OPEN_TARGET_STATUSES] } } },
        { $addFields: { _order: { $indexOfArray: [[...OPEN_TARGET_STATUSES_ORDER], '$status'] } } },
        { $sort: { _order: 1, priority: 1, createdAt: -1, _id: 1 } },
        { $limit: MAX_TARGETS_PER_SUBJECT + 1 },
      ])
      .toArray();
    if (docs.length > MAX_TARGETS_PER_SUBJECT)
      // Cannot happen while the cap holds (create and re-open both check it inside the fence).
      this.ctx.logger.warn({ subjectId, max: MAX_TARGETS_PER_SUBJECT }, 'open targets exceed the cap');
    return docs.slice(0, MAX_TARGETS_PER_SUBJECT).map(({ _order, ...doc }) => doc as CareerTargetDoc);
  }

  /** Edits the spec. Each given part replaces the current one; an edit that changes nothing writes nothing. */
  async edit(id: string, input: EditTargetInput, actor: Actor): Promise<CareerTargetDoc> {
    const e = editTargetInputSchema.parse(input);
    const current = await this.get(id);
    // A stale client gets 409 (reload) before any legality verdict on a state it has not seen.
    this.checkRev(current, e.expectedRev);
    if (!canEditTargetSpec(current, actor))
      throw new ProfessionalError('illegal_transition', 'This target cannot be edited', {
        id,
        status: current.status,
      });
    const next: Record<string, unknown> = {
      label: e.label ?? current.spec.label,
      fit: e.fit ?? current.spec.fit,
      viability: e.viability ?? current.spec.viability,
    };
    const rationale = e.rationale === undefined ? current.spec.rationale : (e.rationale ?? undefined);
    if (rationale !== undefined) next.rationale = rationale;
    const spec = targetSpecSchema.parse(next);
    if (canonicalJson(spec) === canonicalJson(current.spec)) return current;
    // A subject edit of a proposal keeps it proposed but makes it subject-owned: automation can
    // never overwrite it afterwards.
    const subjectOwned = targetActorClass(actor) === 'subject' && current.status === 'proposed';
    return this.commit(
      current,
      { spec, ...(subjectOwned ? { subjectEdited: true } : {}) },
      'spec_edited',
      'operator_edit',
      actor,
      {
        type: 'target.spec_edited',
        reason: 'operator_edit',
      },
    );
  }

  /** Status actions: `activate`, `pause`, `archive` (and `accept` / `decline` of proposals, P5.2). */
  async act(
    id: string,
    action: TargetAction,
    input: TargetActionInput,
    actor: Actor,
  ): Promise<CareerTargetDoc> {
    const { expectedRev } = targetActionInputSchema.parse(input);
    const current = await this.get(id);
    this.checkRev(current, expectedRev);
    const to = targetActionTarget(action, current.status, targetActorClass(actor));
    if (!to)
      throw new ProfessionalError('illegal_transition', 'Illegal target transition', {
        id,
        action,
        status: current.status,
      });
    const origin = action === 'accept' ? 'accepted_proposal' : current.origin;
    return this.commit(
      current,
      { status: to, origin, basis: targetBasis(origin) },
      'status_changed',
      `action_${action}`,
      actor,
      { type: 'target.status_changed', from: current.status, to, reason: `action_${action}` },
    );
  }

  /**
   * Reorders the subject's ranked targets (`active`, `paused`) atomically: `order` must list every
   * ranked target exactly once with the `rev` the caller saw; priorities become 1…n. A missing or
   * extra target → 409 `target_order_mismatch`, a stale `rev` → 409 `stale_target_revision`; either
   * way nothing is written. Only targets whose priority changes get a new version.
   */
  async reorder(subjectId: string, input: ReorderTargetsInput, actor: Actor): Promise<CareerTargetDoc[]> {
    const { order } = reorderTargetsInputSchema.parse(input);
    if (targetActorClass(actor) !== 'subject')
      throw new ProfessionalError('illegal_transition', 'Only the subject can reorder targets', {
        action: 'reorder',
      });
    await this.subjects.get(subjectId);
    await withTransaction(this.ctx.db.client, async (session) => {
      await this.fence(subjectId, session);
      const ranked = await this.col
        .find({ subjectId, status: { $in: ['active', 'paused'] } }, { session })
        .toArray();
      const byId = new Map(ranked.map((t) => [t._id, t]));
      if (ranked.length !== order.length || order.some((o) => !byId.has(o.targetId)))
        throw new ProfessionalError('target_order_mismatch', 'The order must list every ranked target once', {
          ranked: ranked.length,
        });
      const now = this.ctx.clock.now();
      const events: NewEvent[] = [];
      for (const [i, o] of order.entries()) {
        const t = byId.get(o.targetId) as CareerTargetDoc;
        if (t.rev !== o.expectedRev)
          throw new ProfessionalError('stale_target_revision', 'Target changed since it was read', {
            id: t._id,
            rev: t.rev,
          });
        const priority = i + 1;
        if (t.priority === priority) continue;
        const next = validateDocument(careerTargetsCollection, {
          ...t,
          priority,
          rev: t.rev + 1,
          version: t.version + 1,
          updatedAt: now,
        });
        const updated = await this.col.updateOne(
          { _id: t._id, rev: t.rev },
          { $set: { priority, updatedAt: now }, $inc: { rev: 1, version: 1 } },
          { session },
        );
        if (updated.modifiedCount !== 1)
          throw new ProfessionalError('stale_target_revision', 'Target changed since it was read', {
            id: t._id,
          });
        await this.writeVersion(next, 'reordered', 'operator_reorder', actor, session);
        events.push({
          subjectId,
          entity: this.entity(t._id),
          type: 'target.reordered',
          reason: 'operator_reorder',
        });
      }
      if (events.length) {
        const fence = await this.subjects.col.findOne(
          { _id: subjectId },
          { session, projection: { targetsRev: 1 } },
        );
        await this.events.append(`${subjectId}:targets:${fence?.targetsRev ?? 0}`, events, actor, session);
      }
    });
    return this.open(subjectId);
  }

  /** A target's versions, oldest first, keyset-paged over `version` (default 50 per page). */
  async listVersions(
    id: string,
    query: z.input<typeof listTargetVersionsQuerySchema> = {},
  ): Promise<CursorPage<CareerTargetVersionDoc>> {
    const q = listTargetVersionsQuerySchema.parse(query);
    await this.get(id);
    const after = q.cursor ? decodeVersionCursor(q.cursor) : 0;
    const docs = await this.versions
      .find({ targetId: id, version: { $gt: after } })
      .sort({ version: 1 })
      .limit(q.limit + 1)
      .toArray();
    const items = docs.slice(0, q.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: docs.length > q.limit && last ? encodeVersionCursor(last.version) : null,
      limit: q.limit,
    };
  }

  async version(id: string, version: number): Promise<CareerTargetVersionDoc> {
    await this.get(id);
    const v = await this.versions.findOne({ targetId: id, version });
    if (!v) throw notFound('career_target_version', `${id}@${version}`);
    return v;
  }

  // ---------------------------------------------------------------------------------------------

  /** One guarded change: CAS on `rev` (and status), a new version document and an event. */
  private async commit(
    current: CareerTargetDoc,
    change: Partial<Pick<CareerTargetDoc, 'spec' | 'status' | 'origin' | 'basis' | 'subjectEdited'>>,
    kind: TargetChangeKind,
    reason: string,
    actor: Actor,
    event: Omit<NewEvent, 'subjectId' | 'entity'>,
  ): Promise<CareerTargetDoc> {
    const id = current._id;
    return withTransaction(this.ctx.db.client, async (session) => {
      await this.fence(current.subjectId, session);
      const now = this.ctx.clock.now();
      const status = change.status ?? current.status;
      // Re-opening a target (activate from archived) counts towards the open cap like a creation.
      // The fence serializes this count with every other target change of the subject.
      if (!isOpenStatus(current.status) && isOpenStatus(status)) {
        const open = await this.col.countDocuments(
          { subjectId: current.subjectId, status: { $in: [...OPEN_TARGET_STATUSES] } },
          { session },
        );
        if (open >= MAX_TARGETS_PER_SUBJECT)
          throw new ProfessionalError('target_limit_reached', TARGET_LIMIT_MESSAGE, {
            max: MAX_TARGETS_PER_SUBJECT,
          });
      }
      // Entering the ranking takes the next free priority; leaving it drops the priority.
      let priority = current.priority;
      if (!isRankedStatus(status)) priority = undefined;
      else if (!isRankedStatus(current.status))
        priority = await this.nextPriority(current.subjectId, session);
      const { priority: _old, ...base } = current;
      const next = validateDocument(careerTargetsCollection, {
        ...base,
        ...change,
        ...(priority !== undefined ? { priority } : {}),
        rev: current.rev + 1,
        version: current.version + 1,
        updatedAt: now,
      });
      const $set: Record<string, unknown> = { ...change, updatedAt: now };
      if (priority !== undefined) $set.priority = priority;
      const updated = await this.col.findOneAndUpdate(
        { _id: id, rev: current.rev, status: current.status },
        {
          $set,
          ...(priority === undefined ? { $unset: { priority: '' } } : {}),
          $inc: { rev: 1, version: 1 },
        },
        { session, returnDocument: 'after' },
      );
      if (!updated) throw await this.explainMiss(id, current.rev);
      await this.writeVersion(next, kind, reason, actor, session);
      await this.events.append(
        `${id}:v${next.version}`,
        [{ subjectId: current.subjectId, entity: this.entity(id), ...event }],
        actor,
        session,
      );
      return updated;
    });
  }

  /** Serializes ranking changes of one subject; refuses archived subjects. */
  private async fence(subjectId: string, session: ClientSession): Promise<void> {
    const fenced = await this.subjects.col.updateOne(
      { _id: subjectId, status: 'active' },
      { $inc: { targetsRev: 1 } },
      { session },
    );
    if (fenced.matchedCount === 1) return;
    const subject = await this.subjects.col.findOne({ _id: subjectId }, { session });
    if (!subject) throw notFound('subject', subjectId);
    throw new ProfessionalError('subject_archived', 'Subject is archived', { id: subjectId });
  }

  private async nextPriority(subjectId: string, session: ClientSession): Promise<number> {
    const top = await this.col
      .find({ subjectId, status: { $in: ['active', 'paused'] } }, { session, projection: { priority: 1 } })
      .sort({ priority: -1 })
      .limit(1)
      .toArray();
    return (top[0]?.priority ?? 0) + 1;
  }

  private async writeVersion(
    doc: CareerTargetDoc,
    kind: TargetChangeKind,
    reason: string,
    actor: Actor,
    session: ClientSession,
  ): Promise<void> {
    const v = validateDocument(careerTargetVersionsCollection, {
      _id: deterministicId('ptgv', doc._id, doc.version),
      subjectId: doc.subjectId,
      targetId: doc._id,
      version: doc.version,
      status: doc.status,
      ...(doc.priority !== undefined ? { priority: doc.priority } : {}),
      spec: doc.spec as TargetSpec,
      origin: doc.origin,
      basis: doc.basis,
      ...(doc.subjectEdited ? { subjectEdited: true } : {}),
      cause: { kind, reason },
      actor: { kind: actor.kind, id: actor.id },
      attestation: { mode: targetActorClass(actor) === 'subject' ? 'operator_relayed' : 'automation' },
      schemaVersion: TARGET_VERSION_SCHEMA_VERSION,
      createdAt: doc.updatedAt,
      updatedAt: doc.updatedAt,
    });
    await this.versions.insertOne(v, { session });
  }

  private checkReplay(existing: CareerTargetDoc, requestHash: string): CareerTargetDoc {
    if (existing.createRequestHash !== requestHash)
      throw new ProfessionalError(
        'idempotency_key_reused',
        'Idempotency-Key was used with a different request',
      );
    return existing;
  }

  private checkRev(current: CareerTargetDoc, expectedRev: number): void {
    if (current.rev !== expectedRev)
      throw new ProfessionalError('stale_target_revision', 'Target changed since it was read', {
        id: current._id,
        rev: current.rev,
      });
  }

  private async explainMiss(id: string, rev: number): Promise<ProfessionalError> {
    const now = await this.col.findOne({ _id: id });
    if (!now) return notFound('career_target', id);
    return new ProfessionalError('stale_target_revision', 'Target changed since it was read', {
      id,
      rev: now.rev,
      expected: rev,
    });
  }

  private entity(id: string) {
    return { kind: 'career_target' as const, id };
  }
}

function encodeVersionCursor(version: number): string {
  return Buffer.from(JSON.stringify({ v: version })).toString('base64url');
}

function decodeVersionCursor(cursor: string): number {
  try {
    const v = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown }).v;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  } catch {
    /* fall through */
  }
  throw new ProfessionalError('validation_failed', 'Invalid cursor');
}
