import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { MongoClient } from 'mongodb';
import { createAuthHooks } from './auth-hooks';
import { ensureDefaultWorkspace, ensureIdentityCollections } from './collections';
import { UsersService } from './users.service';

/**
 * Better Auth (ADR-0022), exported as `@aptamind/identity/better-auth` so only the admin loads it: MongoDB adapter, Google provider only, mounted at `/api/auth/*` and
 * only reachable when `AUTH_ENABLED` is on. Its collections are named `auth_*` so they never
 * collide with ours (`identity_*`). Created lazily so the admin builds and runs without any
 * auth env when the flag is off.
 */
export const AUTH_MODEL_NAMES = {
  user: 'auth_user',
  session: 'auth_session',
  account: 'auth_account',
  verification: 'auth_verification',
} as const;

export function createAuth(opts: { client: MongoClient; dbName: string; env?: NodeJS.ProcessEnv }) {
  const env = opts.env ?? process.env;
  const db = opts.client.db(opts.dbName);
  let ready: Promise<UsersService> | undefined;
  const users = () =>
    (ready ??= (async () => {
      await ensureIdentityCollections(db);
      await ensureDefaultWorkspace(db);
      return new UsersService({ db, client: opts.client, adminEmail: env.ADMIN_EMAIL || undefined });
    })());
  const hooks = createAuthHooks(users);

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    database: mongodbAdapter(db, { client: opts.client }),
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
      },
    },
    user: { modelName: AUTH_MODEL_NAMES.user },
    session: { modelName: AUTH_MODEL_NAMES.session },
    account: { modelName: AUTH_MODEL_NAMES.account },
    verification: { modelName: AUTH_MODEL_NAMES.verification },
    advanced: {
      useSecureCookies: env.NODE_ENV === 'production',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await hooks.onUserCreated({ id: user.id, email: user.email, name: user.name });
          },
        },
      },
      session: {
        create: {
          before: async (session) => ((await hooks.allowSession(session.userId)) ? undefined : false),
        },
      },
    },
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Promise<Auth> | undefined;

/** Process-wide Better Auth instance on the app's MongoDB (same `MONGODB_URI`/`MONGODB_DB`). */
export function getAuth(): Promise<Auth> {
  return (instance ??= (async () => {
    const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true';
    const client = new MongoClient(uri, { appName: 'aptamind-auth', ignoreUndefined: true });
    await client.connect();
    return createAuth({ client, dbName: process.env.MONGODB_DB ?? 'aptamind' });
  })());
}
