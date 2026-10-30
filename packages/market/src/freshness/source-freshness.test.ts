import { describe, expect, it } from 'vitest';
import { FRESHNESS_POLICIES } from './policies';
import { sourceFreshnessAgeMs, sourceFreshnessState } from './source-freshness';

const NOW = new Date('2026-09-29T12:00:00Z');
const H = 3_600_000;
const source = (policyClass: string, maxAgeMinutes: number, ageMs: number | null, enabled = true) => ({
  enabled,
  freshness: { policyClass, maxAgeMinutes },
  health: { lastSuccessAt: ageMs === null ? undefined : new Date(NOW.getTime() - ageMs) },
});

describe('sourceFreshnessState', () => {
  it('ATS listings (policy: refresh every 6 h) with a 36 h maximum age', () => {
    expect(FRESHNESS_POLICIES['source.ats_listing']!.refreshEveryMs).toBe(6 * H);
    const at = (age: number | null) => sourceFreshnessState(source('source.ats_listing', 36 * 60, age), NOW);
    expect(at(1 * H)).toBe('fresh');
    expect(at(6 * H)).toBe('fresh'); // boundaries are strict
    expect(at(6 * H + 1)).toBe('due');
    expect(at(36 * H)).toBe('due');
    expect(at(36 * H + 1)).toBe('overdue');
    expect(at(null)).toBe('never_succeeded');
  });

  it('follows each known policy: due after its refresh interval, overdue after the source maximum age', () => {
    for (const [cls, policy] of Object.entries(FRESHNESS_POLICIES)) {
      const maxAgeMinutes = Math.ceil((policy.refreshEveryMs * 3) / 60_000);
      const s = (age: number) => sourceFreshnessState(source(cls, maxAgeMinutes, age), NOW);
      expect(s(policy.refreshEveryMs / 2)).toBe('fresh');
      expect(s(policy.refreshEveryMs * 2)).toBe('due');
      expect(s(policy.refreshEveryMs * 4)).toBe('overdue');
    }
  });

  it('has no `due` state when the policy refreshes no sooner than the maximum age, or the class is unknown', () => {
    // Sponsor registers refresh daily; a source allowed only 12 h goes straight from fresh to overdue.
    expect(sourceFreshnessState(source('source.sponsor_register', 12 * 60, 11 * H), NOW)).toBe('fresh');
    expect(sourceFreshnessState(source('source.sponsor_register', 12 * 60, 13 * H), NOW)).toBe('overdue');
    expect(sourceFreshnessState(source('custom.unknown', 60, 59 * 60_000), NOW)).toBe('fresh');
    expect(sourceFreshnessState(source('custom.unknown', 60, 61 * 60_000), NOW)).toBe('overdue');
  });

  it('a disabled source is `disabled` whatever its age', () => {
    expect(sourceFreshnessState(source('source.ats_listing', 60, null, false), NOW)).toBe('disabled');
    expect(sourceFreshnessState(source('source.ats_listing', 60, 100 * H, false), NOW)).toBe('disabled');
  });

  it('age is null when the source never succeeded', () => {
    expect(sourceFreshnessAgeMs(source('x', 60, null), NOW)).toBeNull();
    expect(sourceFreshnessAgeMs(source('x', 60, 5 * H), NOW)).toBe(5 * H);
  });
});
