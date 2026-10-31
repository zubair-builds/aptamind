/**
 * M-U2b: Better Auth hooks → identity with a mocked Google profile, on a real local MongoDB.
 * No Google OAuth client is needed: the hooks are what Better Auth calls after the callback.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { createAuthHooks } from './auth-hooks';
import { AUTH_MODEL_NAMES, createAuth } from './better-auth';
import { ensureDefaultWorkspace, ensureIdentityCollections } from './collections';
import { UsersService } from './users.service';

let client: MongoClient;
let users: UsersService;
const dbName = `t_auth_${randomBytes(4).toString('hex')}`;
const hooks = createAuthHooks(async () => users);
const google = (id: string, email: string) => ({ id, email, name: email.split('@')[0] });

beforeAll(async () => {
  const uri = process.env.MONGODB_URI ?? '';
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri))
    throw new Error('auth integration tests run only against a local MongoDB');
  client = await new MongoClient(uri).connect();
  const db = client.db(dbName);
  await ensureIdentityCollections(db);
  await ensureDefaultWorkspace(db);
  users = new UsersService({ db, client, adminEmail: 'Owner@Example.com' });
});
afterAll(async () => {
  await client
    .db(dbName)
    .dropDatabase()
    .catch(() => {});
  await client.close();
});

describe('Google sign-in outcomes', () => {
  it('ADMIN_EMAIL becomes the first admin and gets a session', async () => {
    const r = await hooks.onUserCreated(google('ba_owner', 'owner@example.com'));
    expect(r).toMatchObject({ outcome: 'active', user: { role: 'admin' } });
    expect(await hooks.allowSession('ba_owner')).toBe(true);
  });
  it('pre-approved email becomes active and gets a session', async () => {
    await users.preApprove('alice@example.com', 'user', 'usr_admin');
    expect((await hooks.onUserCreated(google('ba_alice', 'Alice@example.com'))).outcome).toBe('active');
    expect(await hooks.allowSession('ba_alice')).toBe(true);
  });
  it('unknown email is pending and gets no session until approved', async () => {
    const r = await hooks.onUserCreated(google('ba_bob', 'bob@example.com'));
    expect(r.outcome).toBe('pending_approval');
    expect(await hooks.allowSession('ba_bob')).toBe(false);
    await users.approve(r.user._id, 'usr_admin');
    expect(await hooks.allowSession('ba_bob')).toBe(true);
  });
  it('suspended user is refused and gets no session', async () => {
    const u = await users.preApprove('carol@example.com', 'user', 'usr_admin');
    await users.suspend(u._id);
    expect((await hooks.onUserCreated(google('ba_carol', 'carol@example.com'))).outcome).toBe('suspended');
    expect(await hooks.allowSession('ba_carol')).toBe(false);
    expect(await hooks.allowSession('ba_unknown')).toBe(false);
  });
});

describe('Better Auth instance', () => {
  it('builds with Google only and auth_* collection names', async () => {
    const auth = createAuth({
      client,
      dbName,
      env: {
        NODE_ENV: 'test',
        BETTER_AUTH_SECRET: 'x'.repeat(40),
        BETTER_AUTH_URL: 'http://127.0.0.1:3000',
        GOOGLE_CLIENT_ID: 'test-client',
        GOOGLE_CLIENT_SECRET: 'test-secret',
      },
    });
    expect(Object.keys(auth.options.socialProviders ?? {})).toEqual(['google']);
    expect(auth.options.user?.modelName).toBe(AUTH_MODEL_NAMES.user);
    expect(auth.options.session?.modelName).toBe('auth_session');
    const res = await auth.handler(new Request('http://127.0.0.1:3000/api/auth/get-session'));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});
