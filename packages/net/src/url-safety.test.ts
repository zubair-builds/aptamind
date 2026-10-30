import { describe, expect, it } from 'vitest';
import { isInScope, isPublicAddress, parseAndValidateUrl, UnsafeUrlError } from './url-safety';

const strict = { allowPrivateNetwork: false };

describe('url safety', () => {
  it.each([
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost:4000/',
    'http://metadata.google.internal/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'http://user:pass@example.com/',
    'not a url',
  ])('blocks %s', (url) => {
    expect(() => parseAndValidateUrl(url, strict)).toThrow(UnsafeUrlError);
  });

  it('allows public https urls', () => {
    expect(parseAndValidateUrl('https://boards.greenhouse.io/acme', strict).hostname).toBe(
      'boards.greenhouse.io',
    );
  });

  it('allows private network only when explicitly enabled', () => {
    expect(parseAndValidateUrl('http://127.0.0.1:8080/x', { allowPrivateNetwork: true }).port).toBe('8080');
  });

  it('classifies addresses', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('100.64.0.1')).toBe(false);
    expect(isPublicAddress('fd00::1')).toBe(false);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('enforces host scope', () => {
    const scope = { allowedHosts: ['acme.com'] };
    expect(isInScope('https://acme.com/careers', scope)).toBe(true);
    expect(isInScope('https://www.acme.com/careers', scope)).toBe(true);
    expect(isInScope('https://jobs.acme.com/', scope)).toBe(true);
    expect(isInScope('https://acme.com.evil.io/', scope)).toBe(false);
    expect(isInScope('https://notacme.com/', scope)).toBe(false);
    expect(isInScope('https://jobs.acme.com/', { allowedHosts: ['acme.com'], allowSubdomains: false })).toBe(
      false,
    );
  });
});
