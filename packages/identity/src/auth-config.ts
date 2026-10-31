import { envSchema } from '@aptamind/config';

/**
 * Auth env (ADR-0022, FE-7), validated through the shared `packages/config` schema. Fails closed:
 * when auth is built, every required value must be present — no empty-string or localhost
 * fallbacks. Error messages name variables only, never their values.
 */
const authEnvSchema = envSchema.pick({
  NODE_ENV: true,
  MONGODB_URI: true,
  MONGODB_DB: true,
  AUTH_ENABLED: true,
  GOOGLE_CLIENT_ID: true,
  GOOGLE_CLIENT_SECRET: true,
  BETTER_AUTH_SECRET: true,
  BETTER_AUTH_URL: true,
  ADMIN_EMAIL: true,
});

export interface AuthConfig {
  enabled: boolean;
  nodeEnv: 'development' | 'test' | 'production';
  mongoUri: string;
  mongoDb: string;
  googleClientId: string;
  googleClientSecret: string;
  secret: string;
  baseURL: string;
  adminEmail?: string;
}

export class AuthConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid auth configuration: ${issues.join('; ')}`);
    this.name = 'AuthConfigError';
  }
}

const REQUIRED = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
] as const;

/**
 * Parses and checks the auth env. Throws `AuthConfigError` listing the bad or missing variable
 * names. `requireMongoUri` (default true) also rejects an unset `MONGODB_URI`, so auth never
 * silently falls back to the schema's localhost default.
 */
export function loadAuthConfig(
  env: Record<string, string | undefined> = process.env,
  opts: { requireMongoUri?: boolean } = {},
): AuthConfig {
  const parsed = authEnvSchema.safeParse(env);
  if (!parsed.success)
    throw new AuthConfigError(parsed.error.issues.map((i) => `${i.path.join('.')} is invalid`));
  const e = parsed.data;
  const missing: string[] = REQUIRED.filter((k) => !e[k]);
  if ((opts.requireMongoUri ?? true) && !env.MONGODB_URI?.trim()) missing.push('MONGODB_URI');
  if (missing.length) throw new AuthConfigError(missing.map((k) => `${k} is required`));
  return {
    enabled: e.AUTH_ENABLED,
    nodeEnv: e.NODE_ENV,
    mongoUri: e.MONGODB_URI,
    mongoDb: e.MONGODB_DB,
    googleClientId: e.GOOGLE_CLIENT_ID!,
    googleClientSecret: e.GOOGLE_CLIENT_SECRET!,
    secret: e.BETTER_AUTH_SECRET!,
    baseURL: e.BETTER_AUTH_URL!,
    adminEmail: e.ADMIN_EMAIL,
  };
}

/** Startup check: when `AUTH_ENABLED` is on, throws unless the auth env is complete. */
export function assertAuthConfigAtStartup(env: Record<string, string | undefined> = process.env): void {
  const flag = authEnvSchema.shape.AUTH_ENABLED.safeParse(env.AUTH_ENABLED);
  if (!flag.success || !flag.data) return;
  loadAuthConfig(env);
}
