import type { ClientSession, Collection, Db, MongoClient } from 'mongodb';
import { newId, systemClock, type Clock } from '@aptamind/contracts';
import { isDuplicateKeyError, validateDocument, withTransaction } from '@aptamind/db';
import { IDENTITY_COLLECTIONS, membershipsCollection, usersCollection } from './collections';
import {
  DEFAULT_WORKSPACE_ID,
  IDENTITY_SCHEMA_VERSION,
  IdentityError,
  normaliseEmail,
  type Role,
  type UserDoc,
  type WorkspaceDoc,
  type MembershipDoc,
} from './schemas';

export interface UsersServiceOptions {
  db: Db;
  client: MongoClient;
  clock?: Clock;
  /** Value of `ADMIN_EMAIL`: becomes the first admin on sign-in, only when no admin exists. */
  adminEmail?: string;
  workspaceId?: string;
}

export interface SignInProfile {
  authUserId: string;
  email: string;
  displayName?: string;
  /** Google's `email_verified`. Unverified emails are never linked or bootstrapped. */
  emailVerified: boolean;
}

export type SignInResult =
  | { outcome: 'unverified' }
  | { outcome: 'active'; user: UserDoc }
  | { outcome: 'pending_approval'; user: UserDoc }
  | { outcome: 'suspended'; user: UserDoc };

/** Pure last-admin rule: removing an active admin must leave at least one. */
export function wouldRemoveLastAdmin(
  target: Pick<UserDoc, 'role' | 'status'>,
  activeAdmins: number,
  next: { role?: Role; status?: UserDoc['status'] },
): boolean {
  const isActiveAdmin = target.role === 'admin' && target.status === 'active';
  if (!isActiveAdmin) return false;
  const staysActiveAdmin =
    (next.role ?? target.role) === 'admin' && (next.status ?? target.status) === 'active';
  return !staysActiveAdmin && activeAdmins <= 1;
}

export class UsersService {
  private readonly users: Collection<UserDoc>;
  private readonly workspaces: Collection<WorkspaceDoc>;
  private readonly memberships: Collection<MembershipDoc>;
  private readonly clock: Clock;
  private readonly adminEmail?: string;
  private readonly workspaceId: string;

  constructor(private readonly opts: UsersServiceOptions) {
    this.users = opts.db.collection<UserDoc>(IDENTITY_COLLECTIONS.users);
    this.workspaces = opts.db.collection<WorkspaceDoc>(IDENTITY_COLLECTIONS.workspaces);
    this.memberships = opts.db.collection<MembershipDoc>(IDENTITY_COLLECTIONS.memberships);
    this.clock = opts.clock ?? systemClock;
    this.adminEmail = opts.adminEmail ? normaliseEmail(opts.adminEmail) : undefined;
    this.workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE_ID;
  }

  private now(): Date {
    return this.clock.now();
  }

  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.findOne({ email: normaliseEmail(email) });
  }

  async findByAuthUserId(authUserId: string): Promise<UserDoc | null> {
    return this.users.findOne({ authUserId });
  }

  async get(userId: string): Promise<UserDoc> {
    const u = await this.users.findOne({ _id: userId });
    if (!u) throw new IdentityError('not_found', `User ${userId} not found`);
    return u;
  }

  private newUser(
    email: string,
    role: Role,
    status: UserDoc['status'],
    extra: Partial<UserDoc> = {},
  ): UserDoc {
    const now = this.now();
    return validateDocument(usersCollection, {
      _id: newId('usr'),
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      email,
      workspaceId: this.workspaceId,
      role,
      status,
      permissionOverrides: { grant: [], revoke: [] },
      createdAt: now,
      updatedAt: now,
      ...extra,
    });
  }

  private async addMembership(user: UserDoc): Promise<void> {
    const doc = validateDocument(membershipsCollection, {
      _id: newId('mem'),
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      userId: user._id,
      workspaceId: user.workspaceId,
      role: user.role,
      createdAt: this.now(),
    });
    await this.memberships
      .updateOne({ userId: user._id, workspaceId: user.workspaceId }, { $setOnInsert: doc }, { upsert: true })
      .catch((err) => {
        if (!isDuplicateKeyError(err)) throw err;
      });
  }

  /** Admin pre-approves an email; idempotent for an email already pre-approved. */
  async preApprove(email: string, role: Role, by: string): Promise<UserDoc> {
    const e = normaliseEmail(email);
    const doc = this.newUser(e, role, 'pre_approved', { approvedBy: by, approvedAt: this.now() });
    try {
      await this.users.insertOne(doc);
      await this.addMembership(doc);
      return doc;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const existing = await this.users.findOne({ email: e });
      if (existing?.status === 'pre_approved') return existing;
      throw new IdentityError('already_exists', 'A user with this email already exists');
    }
  }

  /** Approve a `pending_approval` user (they become active). */
  async approve(userId: string, by: string): Promise<UserDoc> {
    const now = this.now();
    const res = await this.users.findOneAndUpdate(
      { _id: userId, status: 'pending_approval' },
      { $set: { status: 'active', approvedBy: by, approvedAt: now, updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!res) throw new IdentityError('invalid_transition', `User ${userId} is not pending approval`);
    return res;
  }

  async setRole(userId: string, role: Role): Promise<UserDoc> {
    return this.guardedUpdate(userId, { role });
  }

  async suspend(userId: string): Promise<UserDoc> {
    return this.guardedUpdate(userId, { status: 'suspended' });
  }

  /**
   * Role/status change under the last-admin rule. The transaction also bumps the workspace
   * `adminRev`, so two concurrent demotions write-conflict instead of both seeing two admins.
   */
  private async guardedUpdate(
    userId: string,
    next: { role?: Role; status?: UserDoc['status'] },
  ): Promise<UserDoc> {
    return withTransaction(this.opts.client, async (session: ClientSession) => {
      const target = await this.users.findOne({ _id: userId }, { session });
      if (!target) throw new IdentityError('not_found', `User ${userId} not found`);
      await this.workspaces.updateOne(
        { _id: target.workspaceId },
        { $inc: { adminRev: 1 }, $set: { updatedAt: this.now() } },
        { session },
      );
      const activeAdmins = await this.users.countDocuments(
        { workspaceId: target.workspaceId, role: 'admin', status: 'active' },
        { session },
      );
      if (wouldRemoveLastAdmin(target, activeAdmins, next))
        throw new IdentityError('last_admin', 'The last admin cannot be demoted or suspended');
      const updated = await this.users.findOneAndUpdate(
        { _id: userId },
        { $set: { ...next, updatedAt: this.now() } },
        { session, returnDocument: 'after' },
      );
      if (next.role)
        await this.memberships.updateOne(
          { userId, workspaceId: target.workspaceId },
          { $set: { role: next.role } },
          { session },
        );
      return updated as UserDoc;
    });
  }

  /**
   * Called from Better Auth's user-create hook (M-U2b) after Google sign-in. Unverified email →
   * refused (nothing written); pre-approved → active; unknown → pending_approval; suspended → refused; `ADMIN_EMAIL` → first admin only
   * when the workspace has no admin yet (unique bootstrap index makes concurrent sign-ins safe).
   */
  async resolveSignIn(profile: SignInProfile): Promise<SignInResult> {
    // Only a provider-verified email may claim a pre-approved record or the ADMIN_EMAIL bootstrap.
    if (profile.emailVerified !== true) return { outcome: 'unverified' };
    const email = normaliseEmail(profile.email);
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.users.findOne({ email });
      if (existing) {
        const linked = await this.linkExisting(existing, profile);
        if (linked) return linked;
        continue; // status changed under us (e.g. a concurrent suspend): re-read and retry
      }

      const extra = { authUserId: profile.authUserId, displayName: profile.displayName };
      if (this.adminEmail === email && (await this.noAdminExists())) {
        const admin = this.newUser(email, 'admin', 'active', {
          ...extra,
          bootstrap: 'first_admin',
          approvedBy: 'bootstrap:ADMIN_EMAIL',
          approvedAt: this.now(),
        });
        try {
          await this.users.insertOne(admin);
          await this.addMembership(admin);
          return { outcome: 'active', user: admin };
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err;
          continue; // same email raced in, or another bootstrap won: re-read
        }
      }
      const pending = this.newUser(email, 'user', 'pending_approval', extra);
      try {
        await this.users.insertOne(pending);
        await this.addMembership(pending);
        return { outcome: 'pending_approval', user: pending };
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
    }
    throw new Error('Could not resolve sign-in after retries');
  }

  private async noAdminExists(): Promise<boolean> {
    const n = await this.users.countDocuments(
      { workspaceId: this.workspaceId, role: 'admin', status: { $ne: 'suspended' } },
      { limit: 1 },
    );
    return n === 0;
  }

  /**
   * Links the auth account to an existing identity. The update is conditional on the status we
   * read, so a concurrent suspend/approve can't be overwritten; on a miss returns null and the
   * caller re-reads.
   */
  private async linkExisting(user: UserDoc, profile: SignInProfile): Promise<SignInResult | null> {
    if (user.status === 'suspended') return { outcome: 'suspended', user };
    if (user.authUserId && user.authUserId !== profile.authUserId)
      throw new IdentityError('already_exists', 'Email is linked to another sign-in account');
    const set: Partial<UserDoc> = { authUserId: profile.authUserId, updatedAt: this.now() };
    if (user.status === 'pre_approved') set.status = 'active';
    if (!user.displayName && profile.displayName) set.displayName = profile.displayName;
    const updated = (await this.users.findOneAndUpdate(
      { _id: user._id, status: user.status },
      { $set: set },
      { returnDocument: 'after' },
    )) as UserDoc | null;
    if (!updated) return null;
    return updated.status === 'active'
      ? { outcome: 'active', user: updated }
      : { outcome: 'pending_approval', user: updated };
  }
}
