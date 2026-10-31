/**
 * M-U2b: Better Auth hooks → identity with a mocked Google profile, on a real local MongoDB.
 * No Google OAuth client is needed: the hooks are what Better Auth calls after the callback.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { createAuthHooks } from './auth-hooks';
import { assertAuthConfigAtStartup, loadAuthConfig } from './auth-config';
import { AUTH_MODEL_NAMES, createAuth } from './better-auth';
import { ensureDefaultWorkspace, ensureIdentityCollections } from './collections';
import { UsersService } from './users.service';

let client: MongoClient;
let users: UsersService;
const dbName = `t_auth_${randomBytes(4).toString('hex')}`;
const hooks = createAuthHooks(async () => users);
const google = (id: string, email: string, emailVerified = true) => ({
  id,
  email,
  name: email.split('@')[0],
  emailVerified,
});

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
    await users.approve((r as { user: { _id: string } }).user._id, 'usr_admin');
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

describe('unverified Google emails (review blocker)', () => {
  it('are refused: never admin, never linked to a pre-approved record, nothing written', async () => {
    const fresh = new UsersService({ db: client.db(`${dbName}_u`), client, adminEmail: 'boss@example.com' });
    const db = client.db(`${dbName}_u`);
    await ensureIdentityCollections(db);
    await ensureDefaultWorkspace(db);
    const h = createAuthHooks(async () => fresh);
    expect((await h.onUserCreated(google('ba_boss', 'boss@example.com', false))).outcome).toBe('unverified');
    expect(await db.collection('identity_users').countDocuments({ role: 'admin' })).toBe(0);
    expect(await h.allowSession('ba_boss', async () => google('ba_boss', 'boss@example.com', false))).toBe(
      false,
    );

    const pre = await fresh.preApprove('dana@example.com', 'user', 'usr_admin');
    expect((await h.onUserCreated(google('ba_dana', 'dana@example.com', false))).outcome).toBe('unverified');
    expect(await fresh.findByAuthUserId('ba_dana')).toBeNull();
    expect((await db.collection('identity_users').findOne({ _id: pre._id as never }))?.status).toBe(
      'pre_approved',
    );
    await db.dropDatabase();
  });
});

describe('lockout recovery on session create', () => {
  it('links an account whose create hook never ran, once its email is pre-approved', async () => {
    // first sign-in: create hook failed, so no identity exists and no session is granted
    const load = async () => google('ba_erin', 'erin@example.com');
    expect(await hooks.allowSession('ba_erin', load)).toBe(false); // resolves → pending
    // a later sign-in for an email pre-approved after the first one recovers via the link path
    expect(await hooks.allowSession('ba_frank', async () => null)).toBe(false);
    await users.preApprove('frank@example.com', 'user', 'usr_admin');
    expect(await hooks.allowSession('ba_frank', async () => google('ba_frank', 'frank@example.com'))).toBe(
      true,
    );
    expect((await users.findByAuthUserId('ba_frank'))?.status).toBe('active');
  });
  it('a pending identity created on the first sign-in gets a session once approved', async () => {
    const pending = await users.findByAuthUserId('ba_erin');
    expect(pending?.status).toBe('pending_approval');
    await users.approve(pending!._id, 'usr_admin');
    expect(await hooks.allowSession('ba_erin')).toBe(true);
  });
  it('ignores a loaded profile for a different auth user', async () => {
    await users.preApprove('gina@example.com', 'user', 'usr_admin');
    expect(await hooks.allowSession('ba_x', async () => google('ba_gina', 'gina@example.com'))).toBe(false);
  });
});

describe('fail-closed auth config', () => {
  const full = {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/x',
    AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'x'.repeat(40),
    BETTER_AUTH_URL: 'http://127.0.0.1:3000',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
  };
  it('throws at startup when AUTH_ENABLED is on and any required value is missing', () => {
    for (const k of [
      'BETTER_AUTH_SECRET',
      'BETTER_AUTH_URL',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'MONGODB_URI',
    ]) {
      const env = { ...full, [k]: '' };
      expect(() => assertAuthConfigAtStartup(env)).toThrow(k);
    }
    expect(() => assertAuthConfigAtStartup(full)).not.toThrow();
  });
  it('does nothing when AUTH_ENABLED is off', () => {
    expect(() => assertAuthConfigAtStartup({ AUTH_ENABLED: 'false' })).not.toThrow();
    expect(() => assertAuthConfigAtStartup({})).not.toThrow();
  });
  it('createAuth refuses an incomplete env instead of using empty fallbacks', () => {
    expect(() => createAuth({ client, dbName, env: { ...full, GOOGLE_CLIENT_SECRET: undefined } })).toThrow(
      'GOOGLE_CLIENT_SECRET is required',
    );
  });
  it('errors never echo values', () => {
    try {
      loadAuthConfig({ ...full, ADMIN_EMAIL: 'not-an-email@', GOOGLE_CLIENT_ID: '' });
    } catch (e) {
      expect(String(e)).not.toContain('not-an-email');
      expect(String(e)).not.toContain(full.BETTER_AUTH_SECRET);
      return;
    }
    throw new Error('expected a throw');
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
    expect(auth.options.trustedOrigins).toEqual(['http://127.0.0.1:3000']);
    const res = await auth.handler(new Request('http://127.0.0.1:3000/api/auth/get-session'));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});
