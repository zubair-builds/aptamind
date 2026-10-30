import { describe, expect, it } from 'vitest';
import type { SourceRef } from './job.schema';
import { isHiddenByProvider } from './job.service';

const ref = (over: Partial<SourceRef>): SourceRef => ({
  key: 's:1',
  sourceId: 's',
  externalId: '1',
  provider: 'ashby',
  authority: 'official_ats',
  postingUrl: null,
  applyUrl: null,
  requisitionId: null,
  firstSeenAt: new Date(0),
  lastSeenAt: new Date(0),
  present: true,
  lastObservationId: 'o',
  contentHash: 'h',
  ...over,
});

describe('isHiddenByProvider (ruling U1)', () => {
  it('is true only when every present copy is hidden by its provider', () => {
    expect(isHiddenByProvider({ sourceRefs: [ref({ providerState: 'unlisted' })] })).toBe(true);
    expect(
      isHiddenByProvider({
        sourceRefs: [ref({ providerState: 'unlisted' }), ref({ key: 't:1', sourceId: 't' })],
      }),
    ).toBe(false);
    expect(
      isHiddenByProvider({
        sourceRefs: [ref({ providerState: 'unlisted' }), ref({ key: 't:1', sourceId: 't', present: false })],
      }),
    ).toBe(true);
    expect(isHiddenByProvider({ sourceRefs: [ref({ present: false, providerState: undefined })] })).toBe(
      false,
    );
  });
});
