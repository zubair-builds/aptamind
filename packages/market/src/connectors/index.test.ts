import { describe, expect, it } from 'vitest';
import { ATS_PROVIDERS } from '../contracts/common';
import { ADAPTERS, getAdapter } from './index';

describe('adapter registry', () => {
  it('has one adapter per ATS provider', () => {
    for (const provider of ATS_PROVIDERS) {
      const adapter = getAdapter(provider);
      expect(adapter.provider).toBe(provider);
      expect(adapter.adapterVersion).toMatch(new RegExp(`^${provider}@\\d+$`));
      expect(ADAPTERS[provider]).toBe(adapter);
    }
  });

  it('encodes board tokens in URLs', () => {
    expect(getAdapter('lever').listingUrl('a/b')).toBe('https://api.lever.co/v0/postings/a%2Fb?mode=json');
  });
});
