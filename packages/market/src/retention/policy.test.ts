import { describe, expect, it } from 'vitest';
import { DAY_MS } from '@aptamind/contracts';
import { expiresAtFor, retentionClassFor } from './policy';

describe('retention policy', () => {
  it('classifies registers, imports and web snapshots', () => {
    expect(retentionClassFor({ via: 'http', authorityTier: 'official_registry' })).toBe('register_snapshot');
    expect(retentionClassFor({ via: 'upload', authorityTier: 'official_registry' })).toBe(
      'register_snapshot',
    );
    expect(retentionClassFor({ via: 'upload' })).toBe('import_file');
    expect(retentionClassFor({ via: 'http', category: 'manual_import' })).toBe('import_file');
    expect(retentionClassFor({ via: 'http', category: 'job_source' })).toBe('web_snapshot');
    expect(retentionClassFor({ via: 'crawl' })).toBe('web_snapshot');
  });
  it('expiry is the class TTL from the given time', () => {
    const t = new Date('2026-01-01T00:00:00Z');
    expect(expiresAtFor('web_snapshot', t).getTime() - t.getTime()).toBe(30 * DAY_MS);
    expect(expiresAtFor('register_snapshot', t).getTime() - t.getTime()).toBe(365 * DAY_MS);
    expect(expiresAtFor('review_evidence', t).getTime() - t.getTime()).toBe(180 * DAY_MS);
  });
});
