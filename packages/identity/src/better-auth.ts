import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { MongoClient } from 'mongodb';
import { loadAuthConfig, type AuthConfig } from './auth-config';
import { createAuthHooks } from './auth-hooks';
import { ensureDefaultWorkspace, ensureIdentityCollections } from './collections';
import { UsersService } from './users.service';

/**
 * Better Auth (ADR-0022), exported as `@aptamind/identity/better-auth` so only the admin loads it: MongoDB adapter, Google provider only, mounted at `/api/auth/*` and
 * only reachable when `AUTH_ENABLED` is on. Its collections are named `auth_*` so they never
 * collide with ours (`identity_*`). Created lazily so the admin builds and runs without any
 * auth env when the flag is off. When built, the auth env is validated and missing values throw
 * (fail closed).
 */
export const AUTH_MODEL_NAMES = {
  user: 'auth_user',
  session: 'auth_session',
  account: 'auth_account',
  verification: 'auth_verification',
} as const;

export function createAuth(opts: {
  client: MongoClient;
  dbName: string;
  env?: Record<string, string | undefined>;
  config?: AuthConfig;
}) {
  const cfg = opts.config ?? loadAuthConfig(opts.env ?? process.env, { requireMongoUri: false });
  const db = opts.client.db(opts.dbName);
  let ready: Promise<UsersService> | undefined;
  const users = () =>
    (ready ??= (async () => {
      await ensureIdentityCollections(db);
      await ensureDefaultWorkspace(db);
      return new UsersService({ db, client: opts.client, adminEmail: cfg.adminEmail });
    })());
  const hooks = createAuthHooks(users);

  return betterAuth({
    secret: cfg.secret,
    baseURL: cfg.baseURL,
    trustedOrigins: [cfg.baseURL],
    basePath: '/api/auth',
    database: mongodbAdapter(db, { client: opts.client }),
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: cfg.googleClientId,
        clientSecret: cfg.googleClientSecret,
      },
    },
    user: { modelName: AUTH_MODEL_NAMES.user },
    session: { modelName: AUTH_MODEL_NAMES.session },
    account: { modelName: AUTH_MODEL_NAMES.account },
    verification: { modelName: AUTH_MODEL_NAMES.verification },
    advanced: {
      useSecureCookies: cfg.nodeEnv === 'production',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await hooks.onUserCreated(toProfile(user));
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            const allowed = await hooks.allowSession(session.userId, async () => {
              const u = await ctx?.context.internalAdapter.findUserById(session.userId);
              return u ? toProfile(u) : null;
            });
            return allowed ? undefined : false;
          },
        },
      },
    },
  });
}

function toProfile(u: { id: string; email: string; name?: string | null; emailVerified?: boolean | null }) {
  return { id: u.id, email: u.email, name: u.name, emailVerified: u.emailVerified === true };
}

type Auth = ReturnType<typeof createAuth>;
let instance: Promise<Auth> | undefined;

/**
 * Process-wide Better Auth instance on the app's MongoDB (config `MONGODB_URI`/`MONGODB_DB`).
 * Throws when the auth env is incomplete; a failed init is not cached, so a fixed env recovers.
 */
export function getAuth(): Promise<Auth> {
  instance ??= (async () => {
    const config = loadAuthConfig(process.env);
    const client = new MongoClient(config.mongoUri, { appName: 'aptamind-auth', ignoreUndefined: true });
    await client.connect();
    return createAuth({ client, dbName: config.mongoDb, config });
  })().catch((err: unknown) => {
    instance = undefined;
    throw err;
  });
  return instance;
}
