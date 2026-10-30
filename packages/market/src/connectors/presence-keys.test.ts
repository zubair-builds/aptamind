import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADAPTERS } from '.';
import type { AtsProvider } from '../contracts/common';

const fixture = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../fixtures/ats/${path}`, import.meta.url), 'utf8'));

const ctx = { boardToken: 'acme' };

/** Every id the full parse saw, split the way presence keys split them. */
function fullParseIds(provider: AtsProvider, raw: unknown) {
  const listing = ADAPTERS[provider].parseListing(raw, ctx);
  const ids = (kind: 'malformed' | 'unlisted') =>
    listing.skipped.filter((s) => s.kind === kind && s.externalId).map((s) => s.externalId!);
  return {
    listed: [...listing.jobs.map((j) => j.payload.externalId), ...ids('malformed')].sort(),
    unlisted: ids('unlisted').sort(),
  };
}

describe('presenceKeys', () => {
  it.each([
    ['greenhouse', 'greenhouse/acme-listing-t1.json'],
    ['greenhouse', 'greenhouse/acme-listing-t2.json'],
    ['ashby', 'ashby/gamma-job-board.json'],
    ['lever', 'lever/beta-co-postings.json'],
  ] as const)('%s %s: matches the ids of the full parse', (provider, path) => {
    const raw = fixture(path);
    const keys = ADAPTERS[provider].presenceKeys(raw, ctx);
    const full = fullParseIds(provider, raw);
    expect([...keys.listed].sort()).toEqual(full.listed);
    expect([...keys.unlisted].sort()).toEqual(full.unlisted);
  });

  it('greenhouse: reads ids and flags a truncated response', () => {
    const raw = { jobs: [{ id: 1 }, { id: '2' }, { title: 'no id' }], meta: { total: 4 } };
    expect(ADAPTERS.greenhouse.presenceKeys(raw, ctx)).toEqual({
      listed: ['1', '2'],
      unlisted: [],
      anonymous: 1,
      complete: false,
    });
    expect(ADAPTERS.greenhouse.presenceKeys({ jobs: [{ id: 1 }], meta: { total: 1 } }, ctx).complete).toBe(
      true,
    );
  });

  it('ashby: splits unlisted entries', () => {
    const raw = { jobs: [{ id: 'a' }, { id: 'b', isListed: false }, { id: 'c', isListed: true }] };
    expect(ADAPTERS.ashby.presenceKeys(raw, ctx)).toEqual({
      listed: ['a', 'c'],
      unlisted: ['b'],
      anonymous: 0,
      complete: true,
    });
  });

  it('lever: reads a top-level array', () => {
    expect(ADAPTERS.lever.presenceKeys([{ id: 'x' }, { id: '' }], ctx)).toEqual({
      listed: ['x'],
      unlisted: [],
      anonymous: 1,
      complete: true,
    });
  });

  it.each(['greenhouse', 'ashby', 'lever'] as const)('%s: throws on the wrong top-level shape', (p) => {
    expect(() => ADAPTERS[p].presenceKeys(p === 'lever' ? { jobs: [] } : [], ctx)).toThrow();
  });
});
