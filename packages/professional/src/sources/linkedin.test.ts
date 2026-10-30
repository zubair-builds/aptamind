import { describe, expect, it } from 'vitest';
import {
  isLinkedInHost,
  isLinkedInUrl,
  LINKEDIN_HOST_REGEX_SOURCE,
  LINKEDIN_URL_REGEX_SOURCE,
} from './linkedin';

const DENIED_URLS = [
  'https://linkedin.com',
  'https://www.linkedin.com/in/someone',
  'https://uk.linkedin.com/in/x?y=1',
  'HTTPS://WWW.LINKEDIN.COM/',
  'https://www.linkedin.com./in/x',
  'https://user@linkedin.com/',
  'https://www.linkedin.com:443/in/x',
  'http://lnkd.in/abc',
  'https://www.linkedin.cn/in/x',
  'https://media.licdn.com/dms/image/x',
];
const ALLOWED_URLS = [
  'https://notlinkedin.com/',
  'https://linkedin.com.evil.example/',
  'https://example.org/?next=linkedin.com',
  'https://github.example/persona',
  'https://notlicdn.com/',
  'https://linkedin.cn.example/',
];

describe('LinkedIn deny-list (PL-11)', () => {
  it.each(DENIED_URLS)('denies %s (parser and server regex agree)', (u) => {
    expect(isLinkedInUrl(u)).toBe(true);
    expect(new RegExp(LINKEDIN_URL_REGEX_SOURCE, 'i').test(u)).toBe(true);
  });

  it.each(ALLOWED_URLS)('allows %s (parser and server regex agree)', (u) => {
    expect(isLinkedInUrl(u)).toBe(false);
    expect(new RegExp(LINKEDIN_URL_REGEX_SOURCE, 'i').test(u)).toBe(false);
  });

  it('classifies hosts', () => {
    for (const h of [
      'linkedin.com',
      'www.linkedin.com',
      'LinkedIn.com',
      'lnkd.in',
      'uk.linkedin.com.',
      'linkedin.cn',
      'static.licdn.com',
    ])
      expect(isLinkedInHost(h) && new RegExp(LINKEDIN_HOST_REGEX_SOURCE, 'i').test(h), h).toBe(true);
    for (const h of ['notlinkedin.com', 'linkedin.com.evil.example', 'lnkd.in.example', 'example.org'])
      expect(isLinkedInHost(h) || new RegExp(LINKEDIN_HOST_REGEX_SOURCE, 'i').test(h), h).toBe(false);
  });
});
