import { describe, expect, it } from 'vitest';
import { INTERPRETATION_POLICY_VERSION } from '../enrichment/interpret';
import { isOlderPolicyVersion } from './reinterpret-backfill';

describe('isOlderPolicyVersion (8d96663 (3) backfill selection)', () => {
  it('older, missing and unparseable versions are older; current and newer are not', () => {
    const current = 'employment-policy/2026-09-29.4';
    expect(isOlderPolicyVersion('employment-policy/2026-09-27.1', current)).toBe(true);
    expect(isOlderPolicyVersion('employment-policy/2026-09-29.3', current)).toBe(true);
    expect(isOlderPolicyVersion(undefined, current)).toBe(true);
    expect(isOlderPolicyVersion('legacy', current)).toBe(true);
    expect(isOlderPolicyVersion(current, current)).toBe(false);
    // Numeric, not lexical: .10 is newer than .4.
    expect(isOlderPolicyVersion('employment-policy/2026-09-29.10', current)).toBe(false);
    expect(isOlderPolicyVersion('employment-policy/2026-10-01.1', current)).toBe(false);
  });
  it('defaults to the current interpreter policy version', () => {
    expect(isOlderPolicyVersion(INTERPRETATION_POLICY_VERSION)).toBe(false);
    expect(isOlderPolicyVersion('employment-policy/2026-09-27.1')).toBe(true);
  });
});
