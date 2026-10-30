import { describe, expect, it } from 'vitest';
import { S3ObjectStorage, s3ClientConfig } from './object-storage';

const base = { region: 'us-east-1', forcePathStyle: true };
const keys = { accessKeyId: 'local-key-id', secretAccessKey: 'local-secret-value' };

describe('s3ClientConfig (FE-3)', () => {
  it('uses only the static keys with an explicit endpoint', () => {
    const cfg = s3ClientConfig({ ...base, ...keys, endpoint: 'http://127.0.0.1:9000' });
    expect(cfg.endpoint).toBe('http://127.0.0.1:9000');
    expect(cfg.credentials).toEqual(keys);
  });

  it('refuses a missing endpoint without the AWS opt-in', () => {
    expect(() => s3ClientConfig({ ...base, ...keys, endpoint: undefined })).toThrow(/Refusing to fall back/);
    expect(() => s3ClientConfig({ ...base, ...keys, endpoint: '' })).toThrow(/Refusing to fall back/);
  });

  it('refuses missing or partial keys on both paths, without printing a key', () => {
    const paths = [
      { endpoint: 'http://127.0.0.1:9000' },
      { endpoint: undefined, useAwsDefaultEndpoint: true },
    ];
    const partial = [
      { accessKeyId: undefined, secretAccessKey: undefined },
      { accessKeyId: 'local-key-id', secretAccessKey: undefined },
      { accessKeyId: undefined, secretAccessKey: 'secret-value' },
      { accessKeyId: '', secretAccessKey: '' },
    ];
    for (const path of paths) {
      for (const k of partial) {
        let message = '';
        try {
          s3ClientConfig({ ...base, ...path, ...k });
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message).toMatch(/ambient AWS credentials/);
        expect(message).not.toContain('secret-value');
      }
    }
  });

  it('allows the AWS default endpoint only on explicit opt-in, with static keys, and not with an endpoint', () => {
    const aws = { ...base, endpoint: undefined, useAwsDefaultEndpoint: true };
    const cfg = s3ClientConfig({ ...aws, ...keys });
    expect(cfg.endpoint).toBeUndefined();
    expect(cfg.credentials).toEqual(keys);
    expect(() => s3ClientConfig({ ...aws, ...keys, endpoint: 'http://127.0.0.1:9000' })).toThrow(/not both/);
  });

  it('fails closed when the adapter is built directly', () => {
    expect(
      () =>
        new S3ObjectStorage({
          ...base,
          bucket: 'b',
          endpoint: undefined,
          accessKeyId: undefined,
          secretAccessKey: undefined,
        }),
    ).toThrow(/Refusing to fall back/);
  });
});
