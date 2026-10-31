import { describe, expect, it } from 'vitest';
import { basicPassword, isAuthorized, isPublicPath, safeEqual } from './basic-auth';

const hdr = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

describe('basic auth', () => {
  it('accepts any username with the right password', async () => {
    expect(await isAuthorized(hdr('anyone', 's3cret'), 's3cret')).toBe(true);
    expect(await isAuthorized(hdr('', 's3cret'), 's3cret')).toBe(true);
  });
  it('rejects wrong, missing, malformed or non-Basic headers', async () => {
    expect(await isAuthorized(hdr('a', 'nope'), 's3cret')).toBe(false);
    expect(await isAuthorized(null, 's3cret')).toBe(false);
    expect(await isAuthorized('Basic !!!', 's3cret')).toBe(false);
    expect(await isAuthorized(`Bearer ${btoa('a:s3cret')}`, 's3cret')).toBe(false);
    expect(await isAuthorized(`Basic ${btoa('nocolon')}`, '')).toBe(false);
  });
  it('keeps colons inside the password and decodes UTF-8', () => {
    expect(basicPassword(hdr('u', 'a:b:c'))).toBe('a:b:c');
    const utf8 = btoa(String.fromCharCode(...new TextEncoder().encode('u:pässword')));
    expect(basicPassword(`Basic ${utf8}`)).toBe('pässword');
  });
  it('safeEqual compares exactly, regardless of length', async () => {
    expect(await safeEqual('abc', 'abc')).toBe(true);
    expect(await safeEqual('abc', 'abcd')).toBe(false);
    expect(await safeEqual('', 'x')).toBe(false);
  });
  it('only /health is public; api, ready, metrics and artifacts are not', () => {
    expect(isPublicPath('/health')).toBe(true);
    for (const p of ['/api/dashboard', '/api/health', '/ready', '/metrics', '/artifacts/x', '/', '/healthz'])
      expect(isPublicPath(p)).toBe(false);
  });
});
