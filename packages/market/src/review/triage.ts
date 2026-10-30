import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type Actor, AppError, ConflictError, contentHash, NotFoundError } from '@aptamind/contracts';
import type { MarketContext } from '../context';
import type { AuditLog } from './audit';
import type { ReviewRepository } from './review.repository';
import type { ReviewItemDoc } from './schemas';

/**
 * Triage claims of review items (Admin ask API-9): an operator marks an open item as theirs while
 * they work on it, so two operators do not pick the same item. A claim is **advisory and
 * cooperative**: it is not the resolution claim of ADR-0017 (`item.claim`, the durable operation
 * that applies one decision), `POST /resolve` does not require it, and any client can
 * force-release it.
 *
 * v0.1 has no user identities (ADR-0008: every request is the same internal operator), so the
 * holder is a **client token** in the body (`holder`, 8–128 chars of `[A-Za-z0-9_-]`, e.g. one
 * random token per browser session), stored only as a hash (`holderHash`) — never echoed raw.
 * The `Idempotency-Key` header is separate: it names one claim/release *attempt* (a replay
 * records no second audit event), as for `resolve`. When authentication arrives the holder
 * becomes the actor. A claim expires after its TTL (≤ 240 minutes), so an abandoned claim never
 * blocks an item.
 */

export const TRIAGE_TTL_DEFAULT_MINUTES = 30;
export const TRIAGE_TTL_MAX_MINUTES = 240;

const holderToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/, 'Expected a holder token of 8–128 characters [A-Za-z0-9_-]');

export const reviewClaimInputSchema = z.strictObject({
  holder: holderToken,
  ttlMinutes: z.number().int().min(1).max(TRIAGE_TTL_MAX_MINUTES).default(TRIAGE_TTL_DEFAULT_MINUTES),
});
export const reviewReleaseInputSchema = z.strictObject({
  holder: holderToken,
  /** Release another holder's live claim (cooperative claims: any client may unstick an item). */
  force: z.boolean().default(false),
});

/** The stored form of a holder token (sha-256): compare with `sha256(yourToken)` client-side. */
export function triageHolderHash(holder: string): string {
  return createHash('sha256').update(holder, 'utf8').digest('hex');
}

type Assignment = NonNullable<ReviewItemDoc['assignment']>;

/** The item's live triage claim (not expired, item still open), else `undefined`. */
export function activeAssignment(item: Pick<ReviewItemDoc, 'assignment' | 'status'>, now: Date) {
  const a = item.assignment;
  return a && item.status === 'open' && a.expiresAt.getTime() > now.getTime() ? a : undefined;
}

/** The item as clients see it: `assignment` only while it is live (open and not expired). */
export function withoutExpiredAssignment<T extends ReviewItemDoc>(item: T, now: Date): T {
  if (!item.assignment || activeAssignment(item, now)) return item;
  const { assignment: _expired, ...rest } = item;
  return rest as T;
}

const describe = (a: Assignment) => ({
  holderHash: a.holderHash,
  claimedAt: a.claimedAt.toISOString(),
  expiresAt: a.expiresAt.toISOString(),
});

/** Audit dedupe key of one attempt: the Idempotency-Key when given (hashed, never stored raw). */
const attemptKey = (id: string, action: string, attempt: string | undefined, now: Date) =>
  attempt ? `${id}:${action}:${contentHash({ attempt })}` : `${id}:${action}:${now.toISOString()}`;

export class ReviewTriage {
  constructor(
    private readonly ctx: MarketContext,
    private readonly repo: ReviewRepository,
    private readonly audit: AuditLog,
  ) {}

  /**
   * Claim (or renew) the triage of an open item for `holder` until now + `ttlMinutes`. A renewal
   * by the live holder keeps `claimedAt`. 409 while another holder's live claim holds it or when
   * the item is closed; 404 for an unknown item.
   */
  async claim(
    id: string,
    input: { holder: string; ttlMinutes: number },
    actor: Actor,
    attempt?: string,
  ): Promise<ReviewItemDoc> {
    const now = this.ctx.clock.now();
    const holderHash = triageHolderHash(input.holder);
    const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60_000);
    const updated = await this.repo.col.findOneAndUpdate(
      {
        _id: id,
        status: 'open',
        $or: [
          { assignment: { $exists: false } },
          { 'assignment.expiresAt': { $lte: now } },
          { 'assignment.holderHash': holderHash },
        ],
      },
      [
        {
          $set: {
            assignment: {
              holderHash,
              actor: { kind: actor.kind, id: actor.id },
              claimedAt: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$assignment.holderHash', holderHash] },
                      { $gt: ['$assignment.expiresAt', now] },
                    ],
                  },
                  '$assignment.claimedAt',
                  now,
                ],
              },
              expiresAt,
            },
            updatedAt: now,
          },
        },
      ],
      { returnDocument: 'after' },
    );
    if (updated) {
      if (updated.assignment!.claimedAt.getTime() === now.getTime())
        await this.audit.record({
          actor,
          action: 'review.claimed',
          // Audited on the review item only: the holder never reaches an entity's audit trail.
          entity: { kind: 'review_item', id },
          reviewItemId: id,
          idempotencyKey: attemptKey(id, 'claim', attempt, now),
          details: { expiresAt: expiresAt.toISOString() },
        });
      return updated;
    }
    const item = await this.repo.col.findOne({ _id: id });
    if (!item) throw new NotFoundError('Review item', id);
    if (item.status !== 'open')
      throw new ConflictError(`Review item ${id} is ${item.status}`, { status: item.status });
    const live = activeAssignment(item, now);
    throw new ConflictError(`Review item ${id} is claimed by another holder`, {
      assignment: live ? describe(live) : null,
    });
  }

  /**
   * Release the item's triage claim held by `holder` (or, with `force`, any live claim).
   * Idempotent: an item without a live claim is returned unchanged. 409 when another holder's
   * live claim holds it and `force` is not set.
   */
  async release(
    id: string,
    input: { holder: string; force: boolean },
    actor: Actor,
    attempt?: string,
  ): Promise<ReviewItemDoc> {
    const now = this.ctx.clock.now();
    const holderHash = triageHolderHash(input.holder);
    // Only a live claim is released; an expired claim or a closed item is left as it is (the item
    // is returned unchanged, nothing is audited).
    const released = await this.repo.col.findOneAndUpdate(
      {
        _id: id,
        status: 'open',
        'assignment.expiresAt': { $gt: now },
        ...(input.force ? {} : { 'assignment.holderHash': holderHash }),
      },
      { $unset: { assignment: '' }, $set: { updatedAt: now } },
      { returnDocument: 'before' },
    );
    if (released) {
      const forced = released.assignment!.holderHash !== holderHash;
      await this.audit.record({
        actor,
        action: forced ? 'review.claim_forced_release' : 'review.released',
        entity: { kind: 'review_item', id },
        reviewItemId: id,
        idempotencyKey: attemptKey(id, 'release', attempt, now),
        // A forced release records whose claim it displaced (the hash, never the token).
        details: forced ? { displacedHolderHash: released.assignment!.holderHash } : {},
      });
      const { assignment: _released, ...rest } = released;
      return { ...rest, updatedAt: now };
    }
    const item = await this.repo.col.findOne({ _id: id });
    if (!item) throw new NotFoundError('Review item', id);
    const live = activeAssignment(item, now);
    if (live)
      throw new ConflictError(`Review item ${id} is claimed by another holder`, {
        assignment: describe(live),
      });
    return withoutExpiredAssignment(item, now);
  }
}

/** The attempt id of a claim/release from its optional `Idempotency-Key` header (≤ 200 chars). */
export function triageAttempt(header: unknown): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || header.length < 1 || header.length > 200)
    throw new AppError('validation_failed', 'Idempotency-Key must be 1–200 characters', {
      header: 'idempotency-key',
    });
  return header;
}
