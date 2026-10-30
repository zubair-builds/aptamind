import { describe, expect, it } from 'vitest';
import { ADAPTERS, apiBaseOfListingUrl, boardSourceIdentity, regionOfApiBase } from './index';

const GH_US = 'https://boards-api.greenhouse.io/v1/boards';
const GH_EU = 'https://boards-api.eu.greenhouse.io/v1/boards';
const LEVER_US = 'https://api.lever.co/v0/postings';
const LEVER_EU = 'https://api.eu.lever.co/v0/postings';
const ASHBY = 'https://api.ashbyhq.com/posting-api/job-board';

describe('M6.3 regional ATS API hosts', () => {
  it('declares the known API bases per provider (default first)', () => {
    expect(ADAPTERS.greenhouse.apiBases).toEqual({ default: GH_US, eu: GH_EU });
    expect(ADAPTERS.lever.apiBases).toEqual({ default: LEVER_US, eu: LEVER_EU });
    expect(ADAPTERS.ashby.apiBases).toEqual({ default: ASHBY });
  });

  it('builds listing and job URLs on a regional base; the default is unchanged', () => {
    const gh = ADAPTERS.greenhouse;
    expect(gh.listingUrl('acme')).toBe(`${GH_US}/acme/jobs?content=true`);
    expect(gh.listingUrl('acme', GH_EU)).toBe(`${GH_EU}/acme/jobs?content=true`);
    expect(gh.jobUrl('acme', '7', GH_EU)).toBe(`${GH_EU}/acme/jobs/7?pay_transparency=true`);
    const lever = ADAPTERS.lever;
    expect(lever.listingUrl('beta')).toBe(`${LEVER_US}/beta?mode=json`);
    expect(lever.listingUrl('beta', LEVER_EU)).toBe(`${LEVER_EU}/beta?mode=json`);
    expect(lever.jobUrl('beta', 'p1', LEVER_EU)).toBe(`${LEVER_EU}/beta/p1`);
    expect(ADAPTERS.ashby.jobUrl('gamma', 'x', ASHBY)).toBe(`${ASHBY}/gamma?includeCompensation=true`);
  });

  it('recovers the API base from a source endpoint (inverse of listingUrl), including test servers', () => {
    for (const [provider, adapter] of Object.entries(ADAPTERS)) {
      for (const base of Object.values(adapter.apiBases)) {
        expect(apiBaseOfListingUrl(adapter.listingUrl('tok-1', base), 'tok-1'), provider).toBe(base);
      }
    }
    expect(apiBaseOfListingUrl('http://127.0.0.1:4010/v1/boards/acme/jobs', 'acme')).toBe(
      'http://127.0.0.1:4010/v1/boards',
    );
    expect(apiBaseOfListingUrl('https://api.eu.lever.co/v0/postings/a%2Fb?mode=json', 'a/b')).toBe(LEVER_EU);
  });

  it.each([
    ['greenhouse', 'boards'],
    ['greenhouse', 'v1'],
    ['lever', 'postings'],
    ['lever', 'v0'],
    ['ashby', 'job-board'],
  ] as const)(
    'A-L1: %s token %j that equals a base path segment recovers the right base',
    (provider, token) => {
      const adapter = ADAPTERS[provider];
      for (const base of Object.values(adapter.apiBases))
        expect(apiBaseOfListingUrl(adapter.listingUrl(token, base), token, adapter)).toBe(base);
      // Any host (test server): the adapter's listing path is stripped from the end.
      const local = 'http://127.0.0.1:4010/some/prefix';
      expect(apiBaseOfListingUrl(adapter.listingUrl(token, local), token, adapter)).toBe(local);
    },
  );

  it('returns null when the endpoint does not carry the board token (never guesses a host)', () => {
    expect(apiBaseOfListingUrl('https://careers.example.com/feed.json', 'acme')).toBeNull();
    expect(
      apiBaseOfListingUrl('https://careers.example.com/feed.json', 'acme', ADAPTERS.greenhouse),
    ).toBeNull();
    expect(apiBaseOfListingUrl('not a url', 'acme')).toBeNull();
    expect(apiBaseOfListingUrl('ftp://boards-api.greenhouse.io/v1/boards/acme/jobs', 'acme')).toBeNull();
  });

  it('names the region of a known base (null for unknown bases)', () => {
    expect(regionOfApiBase(ADAPTERS.greenhouse, GH_US)).toBe('default');
    expect(regionOfApiBase(ADAPTERS.greenhouse, GH_EU)).toBe('eu');
    expect(regionOfApiBase(ADAPTERS.lever, `${LEVER_EU}/`)).toBe('eu');
    expect(regionOfApiBase(ADAPTERS.greenhouse, 'https://evil.example/v1/boards')).toBeNull();
  });

  it('derives the job-source identity: default boards keep provider:token, regional ones add the region', () => {
    expect(boardSourceIdentity(ADAPTERS.greenhouse, 'acme')).toEqual({
      key: 'greenhouse:acme',
      region: 'default',
      apiBase: GH_US,
      listingUrl: `${GH_US}/acme/jobs?content=true`,
    });
    expect(boardSourceIdentity(ADAPTERS.greenhouse, 'acme', null).key).toBe('greenhouse:acme');
    expect(boardSourceIdentity(ADAPTERS.greenhouse, 'acme', GH_EU)).toEqual({
      key: 'greenhouse:eu:acme',
      region: 'eu',
      apiBase: GH_EU,
      listingUrl: `${GH_EU}/acme/jobs?content=true`,
    });
    expect(boardSourceIdentity(ADAPTERS.lever, 'beta', LEVER_EU).key).toBe('lever:eu:beta');
  });

  it('keys a board by its lowercased token; the listing URL keeps the case (OPS-1b)', () => {
    expect(boardSourceIdentity(ADAPTERS.lever, 'RvCase')).toMatchObject({
      key: 'lever:rvcase',
      listingUrl: 'https://api.lever.co/v0/postings/RvCase?mode=json',
    });
    expect(boardSourceIdentity(ADAPTERS.greenhouse, 'AcmeEU', GH_EU).key).toBe('greenhouse:eu:acmeeu');
  });

  it('refuses an API base that is not one of the provider hosts (no endpoint from page content)', () => {
    expect(() => boardSourceIdentity(ADAPTERS.greenhouse, 'acme', 'https://evil.example/v1/boards')).toThrow(
      /not a known greenhouse API host/,
    );
    expect(() => boardSourceIdentity(ADAPTERS.ashby, 'gamma', GH_EU)).toThrow(/not a known ashby API host/);
  });
});
