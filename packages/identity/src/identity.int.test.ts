/**
 * Identity collections and UsersService on a real MongoDB replica set (random database).
 * Needs only MongoDB (`pnpm infra:up` / `infra:local`).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectMongo, type MongoHandle } from '@aptamind/db';
import { ensureDefaultWorkspace, ensureIdentityCollections, IDENTITY_COLLECTIONS } from './collections';
import { UsersService } from './users.service';

let mongo: MongoHandle;

beforeAll(async () => {
  mongo = await connectMongo({
    uri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true',
    dbName: `t_identity_${randomBytes(4).toString('hex')}`,
  });
  await ensureIdentityCollections(mongo.db);
  await ensureDefaultWorkspace(mongo.db);
});
afterAll(async () => {
  await mongo.db.dropDatabase().catch(() => {});
  await mongo.close();
});
beforeEach(async () => {
  await mongo.db.collection(IDENTITY_COLLECTIONS.users).deleteMany({});
  await mongo.db.collection(IDENTITY_COLLECTIONS.memberships).deleteMany({});
});

const svc = (adminEmail?: string) => new UsersService({ db: mongo.db, client: mongo.client, adminEmail });

describe('identity collections', () => {
  it('index sync and workspace seed are idempotent', async () => {
    await ensureIdentityCollections(mongo.db);
    await ensureIdentityCollections(mongo.db);
    await ensureDefaultWorkspace(mongo.db);
    expect(await mongo.db.collection(IDENTITY_COLLECTIONS.workspaces).countDocuments()).toBe(1);
    const names = (await mongo.db.collection(IDENTITY_COLLECTIONS.users).indexes()).map((i) => i.name);
    expect(names).toEqual(
      expect.arrayContaining(['email_unique', 'auth_user_unique', 'bootstrap_admin_unique']),
    );
    const tok = (await mongo.db.collection(IDENTITY_COLLECTIONS.apiTokens).indexes()).map((i) => i.name);
    expect(tok).toContain('hash_unique');
  });

  it('the server validator rejects a raw invalid user', async () => {
    await expect(
      mongo.db
        .collection(IDENTITY_COLLECTIONS.users)
        .insertOne({ _id: 'x' as never, email: 'a@b.co', role: 'root' }),
    ).rejects.toThrow();
  });
});

describe('UsersService', () => {
  it('pre-approved email becomes active on sign-in; unknown is pending', async () => {
    const s = svc();
    await s.preApprove('Alice@Example.com', 'user', 'usr_admin');
    const a = await s.resolveSignIn({ authUserId: 'ba_1', email: 'alice@example.com' });
    expect(a.outcome).toBe('active');
    expect(a.user.authUserId).toBe('ba_1');
    const b = await s.resolveSignIn({ authUserId: 'ba_2', email: 'bob@example.com' });
    expect(b.outcome).toBe('pending_approval');
    expect((await s.approve(b.user._id, 'usr_admin')).status).toBe('active');
  });

  it('suspended users are refused', async () => {
    const s = svc();
    const u = await s.preApprove('c@example.com', 'user', 'usr_admin');
    await s.suspend(u._id);
    expect((await s.resolveSignIn({ authUserId: 'ba_3', email: 'c@example.com' })).outcome).toBe('suspended');
  });

  it('ADMIN_EMAIL bootstraps once, only when no admin exists, even under concurrent sign-ins', async () => {
    const s = svc('owner@example.com');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        s.resolveSignIn({ authUserId: 'ba_owner', email: 'owner@example.com' }),
      ),
    );
    expect(await mongo.db.collection(IDENTITY_COLLECTIONS.users).countDocuments({ role: 'admin' })).toBe(1);
    expect(results.every((r) => r.outcome === 'active' && r.user.role === 'admin')).toBe(true);
  });

  it('ADMIN_EMAIL is not promoted when an admin already exists', async () => {
    const s = svc('owner@example.com');
    const existing = await s.preApprove('first@example.com', 'admin', 'seed');
    await s.resolveSignIn({ authUserId: 'ba_f', email: existing.email });
    const r = await s.resolveSignIn({ authUserId: 'ba_o', email: 'owner@example.com' });
    expect(r.outcome).toBe('pending_approval');
    expect(r.user.role).toBe('user');
  });

  it('the last admin cannot be demoted or suspended, also under concurrent demotions', async () => {
    const s = svc();
    const a1 = await s.preApprove('a1@example.com', 'admin', 'seed');
    const a2 = await s.preApprove('a2@example.com', 'admin', 'seed');
    await s.resolveSignIn({ authUserId: 'ba_a1', email: a1.email });
    await s.resolveSignIn({ authUserId: 'ba_a2', email: a2.email });
    const res = await Promise.allSettled([s.setRole(a1._id, 'user'), s.setRole(a2._id, 'user')]);
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(
      await mongo.db
        .collection(IDENTITY_COLLECTIONS.users)
        .countDocuments({ role: 'admin', status: 'active' }),
    ).toBe(1);
    const remaining = res[0]!.status === 'fulfilled' ? a2 : a1;
    await expect(s.suspend(remaining._id)).rejects.toMatchObject({ code: 'last_admin' });
  });
});
