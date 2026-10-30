import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig as loadRaw,
  MISSING_S3_ENDPOINT,
  MISSING_S3_KEYS,
  resolveCredential,
  UNSAFE_BIND_ACK,
} from './index';

const LOCAL_S3 = {
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_ACCESS_KEY_ID: 'local-key-id',
  S3_SECRET_ACCESS_KEY: 'local-secret-value',
};
/** Most tests are not about storage: give them a valid explicit local endpoint. */
const loadConfig = (env: Record<string, string> = {}) => loadRaw({ ...LOCAL_S3, ...env });

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig({});
    expect(cfg.api.port).toBe(4000);
    expect(cfg.net.allowPrivateNetwork).toBe(false);
    expect(cfg.ai.provider).toBe('none');
  });

  it('parses booleans and lists', () => {
    const cfg = loadConfig({ NET_ALLOW_PRIVATE_NETWORK: 'true', API_CORS_ORIGINS: 'http://a, http://b' });
    expect(cfg.net.allowPrivateNetwork).toBe(true);
    expect(cfg.api.corsOrigins).toEqual(['http://a', 'http://b']);
  });

  it('defaults to the shared Redis host limiter and checks the lease TTL', () => {
    const cfg = loadConfig({});
    expect(cfg.net.hostLimiter).toBe('redis');
    expect(cfg.net.hostLeaseTtlMs).toBe(120_000);
    expect(loadConfig({ NET_HOST_LIMITER: 'memory' }).net.hostLimiter).toBe('memory');
    expect(() => loadConfig({ NET_HOST_LIMITER: 'other' })).toThrow(ConfigError);
    expect(() => loadConfig({ NET_HOST_LEASE_TTL_MS: '20000' })).toThrow(/NET_HOST_LEASE_TTL_MS/);
  });

  it('rejects invalid values with readable errors', () => {
    expect(() => loadConfig({ API_PORT: 'abc' })).toThrow(ConfigError);
  });

  it('refuses unsafe production settings', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', NET_ALLOW_PRIVATE_NETWORK: 'true' })).toThrow(
      /NET_ALLOW_PRIVATE_NETWORK/,
    );
    expect(() => loadConfig({ NODE_ENV: 'production', API_HOST: '0.0.0.0' })).toThrow(/no authentication/);
  });

  it('resolves credential references from the environment', () => {
    expect(resolveCredential({ kind: 'env', name: 'X_KEY' }, { X_KEY: 'v' })).toBe('v');
  });
});

describe('production bind guard (audit M-4)', () => {
  const prod =
    (API_HOST: string, extra: Record<string, string> = {}) =>
    () =>
      loadConfig({ NODE_ENV: 'production', API_HOST, ...extra });

  it.each([
    '127.0.0.1',
    '127.8.9.10',
    '::1',
    '[::1]',
    '10.1.2.3',
    '172.16.0.5',
    '172.31.255.1',
    '192.168.1.20',
    '100.64.0.9',
    'fd12:3456::1',
    '::ffff:10.0.0.1',
  ])('accepts loopback/private address %s', (host) => {
    expect(prod(host)).not.toThrow();
  });

  it.each([
    ['0.0.0.0', /unspecified/],
    ['::', /unspecified/],
    ['0:0:0:0:0:0:0:0', /unspecified/],
    ['[::]', /unspecified/],
    ['8.8.8.8', /not a loopback or private/],
    ['172.32.0.1', /not a loopback or private/],
    ['169.254.10.10', /not a loopback or private/],
    ['2001:db8::1', /not a loopback or private/],
    ['::ffff:8.8.8.8', /not a loopback or private/],
    ['api.example.com', /hostname/],
    ['localhost', /hostname/],
  ])('refuses %s', (host, reason) => {
    expect(prod(host)).toThrow(reason);
    expect(prod(host)).toThrow(/no authentication/);
  });

  it('only the exact acknowledgement phrase overrides it', () => {
    expect(prod('0.0.0.0', { API_ALLOW_UNSAFE_PUBLIC_BIND: 'true' })).toThrow(/no authentication/);
    expect(prod('0.0.0.0', { API_ALLOW_UNSAFE_PUBLIC_BIND: UNSAFE_BIND_ACK })).not.toThrow();
  });

  it('does not apply outside production', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', API_HOST: '0.0.0.0' })).not.toThrow();
  });
});

describe('storage endpoint (FE-3)', () => {
  const issues = (env: Record<string, string | undefined>) => {
    try {
      loadRaw(env);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return (err as ConfigError).issues;
    }
    return [];
  };

  it('refuses a missing endpoint with a message that names it and points at .env.example', () => {
    const SECRET = 'should-never-be-printed';
    for (const env of [{}, { S3_ENDPOINT: '' }, { S3_USE_AWS_DEFAULT_ENDPOINT: 'false' }]) {
      const found = issues({ ...env, S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: SECRET });
      expect(found).toEqual([MISSING_S3_ENDPOINT]);
    }
    expect(MISSING_S3_ENDPOINT).toMatch(/S3_ENDPOINT/);
    expect(MISSING_S3_ENDPOINT).toMatch(/\.env\.example/);
    expect(MISSING_S3_ENDPOINT).toMatch(/S3_USE_AWS_DEFAULT_ENDPOINT=true/);
  });

  it('accepts an explicit endpoint with static keys', () => {
    const cfg = loadRaw({ ...LOCAL_S3, S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com' });
    expect(cfg.s3.endpoint).toBe('https://acc.r2.cloudflarestorage.com');
    expect(cfg.s3.useAwsDefaultEndpoint).toBe(false);
  });

  it('refuses an endpoint that is not an http(s) URL', () => {
    expect(issues({ ...LOCAL_S3, S3_ENDPOINT: '127.0.0.1:9000' }).join()).toMatch(/S3_ENDPOINT/);
    expect(issues({ ...LOCAL_S3, S3_ENDPOINT: 'ftp://127.0.0.1' }).join()).toMatch(/S3_ENDPOINT/);
  });

  it('refuses missing or partial keys on every path, and never prints a key', () => {
    const SECRET = 'should-never-be-printed';
    const paths = [{ S3_ENDPOINT: 'http://127.0.0.1:9000' }, { S3_USE_AWS_DEFAULT_ENDPOINT: 'true' }];
    for (const path of paths) {
      for (const keys of [{}, { S3_ACCESS_KEY_ID: 'id' }, { S3_SECRET_ACCESS_KEY: SECRET }]) {
        const found = issues({ ...path, ...keys });
        expect(found).toEqual([MISSING_S3_KEYS]);
        expect(found.join()).not.toContain(SECRET);
      }
    }
    expect(MISSING_S3_KEYS).toMatch(/S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/);
    expect(MISSING_S3_KEYS).toMatch(/ambient AWS credentials/);
  });

  it('uses the AWS default endpoint only on explicit opt-in, with static keys', () => {
    const cfg = loadRaw({
      S3_USE_AWS_DEFAULT_ENDPOINT: 'true',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 's',
    });
    expect(cfg.s3.endpoint).toBeUndefined();
    expect(cfg.s3.useAwsDefaultEndpoint).toBe(true);
    expect(cfg.s3.accessKeyId).toBe('id');
  });

  it('treats a blank S3_REGION as unset', () => {
    expect(loadRaw({ ...LOCAL_S3, S3_REGION: '' }).s3.region).toBe('us-east-1');
    expect(loadRaw({ ...LOCAL_S3, S3_REGION: 'auto' }).s3.region).toBe('auto');
  });

  it('refuses the AWS opt-in together with an endpoint', () => {
    expect(issues({ ...LOCAL_S3, S3_USE_AWS_DEFAULT_ENDPOINT: 'true' })).toEqual([
      'S3_ENDPOINT and S3_USE_AWS_DEFAULT_ENDPOINT=true are both set; set exactly one of them',
    ]);
  });
});
