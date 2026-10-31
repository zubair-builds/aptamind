import { describe, expect, it } from 'vitest';
import { isOnCompanyHosts } from './companies';

describe('isOnCompanyHosts (wave 6: only official hosts are crawled automatically)', () => {
  it('accepts the official domain, its subdomains and the website host', () => {
    expect(isOnCompanyHosts('https://acme.com/careers', 'acme.com', null)).toBe(true);
    expect(isOnCompanyHosts('https://www.acme.com/careers', 'acme.com', null)).toBe(true);
    expect(isOnCompanyHosts('https://careers.acme.com/', 'acme.com', null)).toBe(true);
    expect(isOnCompanyHosts('http://127.0.0.1:4000/careers', 'acme.example', 'http://127.0.0.1:4000/')).toBe(
      true,
    );
  });
  it('refuses other hosts, look-alikes, non-web schemes and garbage', () => {
    expect(
      isOnCompanyHosts('https://jobs-portal.example/careers/acme', 'acme.com', 'https://acme.com/'),
    ).toBe(false);
    expect(isOnCompanyHosts('https://notacme.com/careers', 'acme.com', null)).toBe(false);
    expect(isOnCompanyHosts('https://acme.com.evil.io/careers', 'acme.com', null)).toBe(false);
    expect(isOnCompanyHosts('ftp://acme.com/careers', 'acme.com', null)).toBe(false);
    expect(isOnCompanyHosts('not a url', 'acme.com', null)).toBe(false);
    expect(isOnCompanyHosts('https://acme.com/careers', null, null)).toBe(false);
  });
  it('refuses shared hosting and non-default ports (PR #6 review)', () => {
    expect(isOnCompanyHosts('https://acme.github.io/careers', 'acme.github.io', null)).toBe(false);
    expect(isOnCompanyHosts('https://acme.github.io/careers', null, 'https://acme.github.io/')).toBe(false);
    expect(isOnCompanyHosts('https://acme.notion.site/jobs', null, 'https://acme.notion.site')).toBe(false);
    expect(
      isOnCompanyHosts('https://sites.google.com/view/acme', null, 'https://sites.google.com/view/acme'),
    ).toBe(false);
    expect(isOnCompanyHosts('https://acme.wixsite.com/acme/careers', 'acme.wixsite.com', null)).toBe(false);
    expect(isOnCompanyHosts('https://acme.com:8443/careers', 'acme.com', 'https://acme.com/')).toBe(false);
    expect(isOnCompanyHosts('https://acme.com:443/careers', 'acme.com', null)).toBe(true);
    expect(isOnCompanyHosts('http://127.0.0.1:4001/careers', null, 'http://127.0.0.1:4000/')).toBe(false);
  });
});
