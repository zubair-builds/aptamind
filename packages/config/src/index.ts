import { z } from 'zod';

/**
 * Environment/configuration validation.
 *
 * Every process (api, worker, admin, scripts) loads configuration through `loadConfig` so a
 * misconfigured deployment fails fast at boot with a readable error instead of at first use.
 * Secrets are never embedded in workflow definitions; they are referenced by name
 * (`CredentialRef`) and resolved from the environment here.
 */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

/** A blank line such as `S3_ENDPOINT=` in an env file means "unset", not an empty value. */
const blankAsUnset = (v: unknown) => (v === '' ? undefined : v);

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_NAME: z.string().default('aptamind'),

  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true'),
  MONGODB_DB: z.string().min(1).default('aptamind'),

  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
  QUEUE_PREFIX: z.string().min(1).default('aptamind'),

  /** Required unless S3_USE_AWS_DEFAULT_ENDPOINT=true (see storageIssues). */
  S3_ENDPOINT: z.preprocess(
    blankAsUnset,
    z.url({ protocol: /^https?$/, error: 'must be an http:// or https:// URL' }).optional(),
  ),
  S3_USE_AWS_DEFAULT_ENDPOINT: bool.default(false),
  S3_REGION: z.preprocess(blankAsUnset, z.string().default('us-east-1')),
  S3_BUCKET: z.string().default('aptamind-artifacts'),
  S3_ACCESS_KEY_ID: z.preprocess(blankAsUnset, z.string().optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess(blankAsUnset, z.string().optional()),
  S3_FORCE_PATH_STYLE: bool.default(true),

  API_HOST: z.string().default('127.0.0.1'),
  /** Explicit, deliberately awkward override of the production bind guard (see classifyBindHost). */
  API_ALLOW_UNSAFE_PUBLIC_BIND: z.string().optional(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_CORS_ORIGINS: csv,

  WORKER_ID: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(8),
  WORKER_QUEUES: csv,
  WORKER_SCHEDULER_ENABLED: bool.default(true),
  WORKER_SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(250).default(5_000),
  WORKER_SWEEPER_INTERVAL_MS: z.coerce.number().int().min(250).default(15_000),
  WORKER_LEASE_MS: z.coerce.number().int().min(1_000).default(60_000),
  WORKER_METRICS_PORT: z.coerce.number().int().min(0).default(4101),

  NET_ALLOW_PRIVATE_NETWORK: bool.default(false),
  NET_USER_AGENT: z.string().default('AptamindMarketBot/0.1 (+internal; contact: ops@aptamind.invalid)'),
  NET_DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(100).default(20_000),
  NET_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(50 * 1024 * 1024),
  NET_PER_HOST_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  NET_PER_HOST_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(250),
  /** `redis` shares the per-host budget across all processes; `memory` keeps one per process. */
  NET_HOST_LIMITER: z.enum(['redis', 'memory']).default('redis'),
  NET_HOST_LEASE_TTL_MS: z.coerce.number().int().min(1_000).default(120_000),

  BROWSER_EXECUTABLE_PATH: z.string().optional(),

  AI_PROVIDER: z.enum(['none', 'anthropic', 'gemini', 'fixture']).default('none'),
  AI_MODEL: z.string().default('claude-opus-5'),
  AI_API_KEY_ENV: z.string().default('ANTHROPIC_API_KEY'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),

});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  logLevel: Env['LOG_LEVEL'];
  serviceName: string;
  mongo: { uri: string; dbName: string };
  redis: { url: string; queuePrefix: string };
  s3: {
    /** Undefined only when `useAwsDefaultEndpoint` is true. */
    endpoint: string | undefined;
    useAwsDefaultEndpoint: boolean;
    region: string;
    bucket: string;
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    forcePathStyle: boolean;
  };
  api: { host: string; port: number; corsOrigins: string[] };
  worker: {
    id: string | undefined;
    concurrency: number;
    queues: string[];
    schedulerEnabled: boolean;
    schedulerIntervalMs: number;
    sweeperIntervalMs: number;
    leaseMs: number;
    metricsPort: number;
  };
  net: {
    allowPrivateNetwork: boolean;
    userAgent: string;
    defaultTimeoutMs: number;
    maxResponseBytes: number;
    perHostConcurrency: number;
    perHostMinIntervalMs: number;
    hostLimiter: Env['NET_HOST_LIMITER'];
    hostLeaseTtlMs: number;
  };
  browser: { executablePath: string | undefined };
  ai: { provider: Env['AI_PROVIDER']; model: string; apiKeyEnv: string; timeoutMs: number };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Exact value required to bind the unauthenticated API to a non-private address in production. */
export const UNSAFE_BIND_ACK = 'i-understand-this-exposes-an-unauthenticated-api';

export type BindHostKind = 'loopback' | 'private' | 'unspecified' | 'public' | 'hostname' | 'invalid';

/**
 * Classify an API bind host. Only IP literals are trusted: a hostname's resolution can change
 * after startup (or differ between resolvers), so it is not accepted as proof of a private bind.
 */
export function classifyBindHost(host: string): { kind: BindHostKind; reason: string } {
  const h = host
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  const v4 = parseIPv4(h) ?? mappedIPv4(h);
  if (v4) {
    const [a = 0, b = 0] = v4;
    if (v4.every((o) => o === 0))
      return { kind: 'unspecified', reason: 'the unspecified address (all interfaces)' };
    if (a === 127) return { kind: 'loopback', reason: 'loopback' };
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
      return { kind: 'private', reason: 'a private address' };
    return { kind: 'public', reason: 'not a loopback or private address' };
  }
  if (h.includes(':')) {
    const full = expandIPv6(h);
    if (!full) return { kind: 'invalid', reason: 'not a valid IP address' };
    if (full.every((g) => g === 0))
      return { kind: 'unspecified', reason: 'the unspecified address (all interfaces)' };
    if (full.slice(0, 7).every((g) => g === 0) && full[7] === 1)
      return { kind: 'loopback', reason: 'loopback' };
    if (((full[0] ?? 0) & 0xfe00) === 0xfc00) return { kind: 'private', reason: 'a unique-local address' };
    return { kind: 'public', reason: 'not a loopback or private address' };
  }
  if (h === 'localhost') return { kind: 'hostname', reason: 'a hostname (use 127.0.0.1)' };
  return { kind: 'hostname', reason: 'a hostname, which may resolve to a public address' };
}

function parseIPv4(h: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : null;
}

function mappedIPv4(h: string): number[] | null {
  const m = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  return m ? parseIPv4(m[1] ?? '') : null;
}

function expandIPv6(h: string): number[] | null {
  if (!/^[0-9a-f:]+$/.test(h) || (h.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = h.includes('::') ? h.split('::') : [h, undefined];
  const parse = (part: string | undefined) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const a = parse(head);
  const b = parse(tail);
  if ([...a, ...b].some((g) => Number.isNaN(g) || g > 0xffff)) return null;
  const fill = 8 - a.length - b.length;
  if (tail === undefined ? a.length !== 8 : fill < 0) return null;
  return [...a, ...new Array(Math.max(0, fill)).fill(0), ...b];
}

export const MISSING_S3_ENDPOINT =
  'S3_ENDPOINT is not set. Set it to an S3-compatible endpoint: local SeaweedFS is http://127.0.0.1:9000, ' +
  'Cloudflare R2 is https://<account-id>.r2.cloudflarestorage.com. Scripts do not load .env; export it ' +
  'first (set -a; . ./.env; set +a), starting from .env.example. To use Amazon S3 on purpose, leave ' +
  'S3_ENDPOINT unset and set S3_USE_AWS_DEFAULT_ENDPOINT=true.';

export const MISSING_S3_KEYS =
  'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must both be set: the storage client never falls back to ' +
  'ambient AWS credentials (~/.aws, AWS_PROFILE, instance metadata). See .env.example';

/**
 * Without an endpoint the AWS SDK silently targets real Amazon S3, and without static keys it
 * uses the ambient AWS credentials. So the endpoint (or the opt-in) and both keys are always
 * required (FE-3). Messages name variables only, never their values.
 */
function storageIssues(e: Env): string[] {
  const issues: string[] = [];
  if (e.S3_USE_AWS_DEFAULT_ENDPOINT && e.S3_ENDPOINT) {
    issues.push('S3_ENDPOINT and S3_USE_AWS_DEFAULT_ENDPOINT=true are both set; set exactly one of them');
  } else if (!e.S3_USE_AWS_DEFAULT_ENDPOINT && !e.S3_ENDPOINT) {
    issues.push(MISSING_S3_ENDPOINT);
  }
  if (!e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY) issues.push(MISSING_S3_KEYS);
  return issues;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const issues: string[] = [];
  if (e.NODE_ENV === 'production') {
    if (e.NET_ALLOW_PRIVATE_NETWORK) issues.push('NET_ALLOW_PRIVATE_NETWORK must be false in production');
    const bind = classifyBindHost(e.API_HOST);
    if (
      bind.kind !== 'loopback' &&
      bind.kind !== 'private' &&
      e.API_ALLOW_UNSAFE_PUBLIC_BIND !== UNSAFE_BIND_ACK
    ) {
      issues.push(
        `API_HOST=${e.API_HOST} in production is ${bind.reason}: the API has no authentication in v0.1 and must bind ` +
          'to an explicit loopback or private-network IP address (or set API_ALLOW_UNSAFE_PUBLIC_BIND to the documented ' +
          'acknowledgement phrase — never for an internet-facing interface)',
      );
    }
  }
  // A lease that expires mid-request frees its slot early, and the host gets more than its budget.
  if (e.NET_HOST_LEASE_TTL_MS <= e.NET_DEFAULT_TIMEOUT_MS) {
    issues.push('NET_HOST_LEASE_TTL_MS must be greater than NET_DEFAULT_TIMEOUT_MS');
  }
  issues.push(...storageIssues(e));
  if (issues.length) throw new ConfigError(issues);
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    serviceName: e.SERVICE_NAME,
    mongo: { uri: e.MONGODB_URI, dbName: e.MONGODB_DB },
    redis: { url: e.REDIS_URL, queuePrefix: e.QUEUE_PREFIX },
    s3: {
      endpoint: e.S3_ENDPOINT,
      useAwsDefaultEndpoint: e.S3_USE_AWS_DEFAULT_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
    },
    api: { host: e.API_HOST, port: e.API_PORT, corsOrigins: e.API_CORS_ORIGINS },
    worker: {
      id: e.WORKER_ID,
      concurrency: e.WORKER_CONCURRENCY,
      queues: e.WORKER_QUEUES,
      schedulerEnabled: e.WORKER_SCHEDULER_ENABLED,
      schedulerIntervalMs: e.WORKER_SCHEDULER_INTERVAL_MS,
      sweeperIntervalMs: e.WORKER_SWEEPER_INTERVAL_MS,
      leaseMs: e.WORKER_LEASE_MS,
      metricsPort: e.WORKER_METRICS_PORT,
    },
    net: {
      allowPrivateNetwork: e.NET_ALLOW_PRIVATE_NETWORK,
      userAgent: e.NET_USER_AGENT,
      defaultTimeoutMs: e.NET_DEFAULT_TIMEOUT_MS,
      maxResponseBytes: e.NET_MAX_RESPONSE_BYTES,
      perHostConcurrency: e.NET_PER_HOST_CONCURRENCY,
      perHostMinIntervalMs: e.NET_PER_HOST_MIN_INTERVAL_MS,
      hostLimiter: e.NET_HOST_LIMITER,
      hostLeaseTtlMs: e.NET_HOST_LEASE_TTL_MS,
    },
    browser: { executablePath: e.BROWSER_EXECUTABLE_PATH },
    ai: {
      provider: e.AI_PROVIDER,
      model: e.AI_MODEL,
      apiKeyEnv: e.AI_API_KEY_ENV,
      timeoutMs: e.AI_TIMEOUT_MS,
    },
  };
}

/**
 * Reference to a secret by name. v0.1 resolves references from environment variables.
 * Workflow definitions and source configurations store only the reference, never the value.
 */
export interface CredentialRef {
  kind: 'env';
  name: string;
}

export function resolveCredential(
  ref: CredentialRef,
  source: Record<string, string | undefined> = process.env,
): string | undefined {
  if (ref.kind === 'env') return source[ref.name];
  return undefined;
}
