import { describe, expect, it } from 'vitest';
import { type FactCandidate, selectFact } from './index';

const ev = (sourceId: string) => ({ sourceId, observedAt: new Date('2026-01-01') });
const c = <T>(
  value: T,
  authority: FactCandidate<T>['authority'],
  at: string,
  confidence: FactCandidate<T>['confidence'] = 'high',
): FactCandidate<T> => ({
  value,
  authority,
  confidence,
  evidence: ev(`src_${authority}_${at}`),
  observedAt: new Date(at),
});

describe('selectFact', () => {
  it('returns unknown without candidates', () => {
    expect(selectFact([], { policyVersion: 'p1' })).toMatchObject({ value: null, status: 'unknown' });
  });

  it('prefers higher authority and keeps the loser as a conflict', () => {
    const f = selectFact(
      [c('acme.io', 'third_party', '2026-03-01'), c('acme.com', 'official_site', '2026-01-01')],
      { policyVersion: 'p1' },
    );
    expect(f.value).toBe('acme.com');
    expect(f.conflicts).toEqual([expect.objectContaining({ value: 'acme.io', reason: 'lower authority' })]);
  });

  it('aggregates agreeing evidence', () => {
    const f = selectFact([c('x', 'third_party', '2026-01-01'), c('x', 'third_party', '2026-02-01')], {
      policyVersion: 'p1',
    });
    expect(f.evidence).toHaveLength(2);
    expect(f.confidence.reasons).toContain('2 observations agree');
  });

  it('marks equal-authority disagreement as conflicting when policy demands', () => {
    const f = selectFact([c('a', 'official_ats', '2026-01-01'), c('b', 'official_ats', '2026-02-01')], {
      policyVersion: 'p1',
      sameAuthorityDisagreement: 'conflict',
    });
    expect(f).toMatchObject({ value: null, status: 'conflicting' });
    expect(f.conflicts).toHaveLength(1);
  });

  it('uses recency for equal-authority disagreement by default and lowers confidence', () => {
    const f = selectFact([c('a', 'official_ats', '2026-01-01'), c('b', 'official_ats', '2026-02-01')], {
      policyVersion: 'p1',
    });
    expect(f.value).toBe('b');
    expect(f.confidence.level).toBe('medium');
  });
});
