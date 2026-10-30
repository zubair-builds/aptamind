import { describe, expect, it } from 'vitest';
import { interpretRelocation } from './relocation';

describe('interpretRelocation', () => {
  it.each([
    ['Relocation assistance is provided.', 'explicit_yes'],
    ['We offer a generous relocation package.', 'explicit_yes'],
    ['We will help you relocate to Lisbon.', 'explicit_yes'],
    ['Relocation: yes', 'explicit_yes'],
    ['Relocation is not offered for this role.', 'explicit_no'],
    ['Relocation is not available.', 'explicit_no'],
    ['We are unable to offer relocation support.', 'explicit_no'],
    ['No relocation.', 'explicit_no'],
    ['Relocation may be considered.', 'possible'],
    ['We are open to relocation support for exceptional candidates.', 'possible'],
    ['Relocation assistance is negotiable.', 'possible'],
  ])('%s → %s', (text, status) => {
    const r = interpretRelocation(text);
    expect(r.value).toBe(status);
    expect(r.evidence[0]?.quote).toBe(text);
  });

  it('does not treat a candidate relocation requirement as support', () => {
    expect(interpretRelocation('You must be willing to relocate to Berlin.').value).toBe('unclear');
  });

  it('explicit no wins over an offer elsewhere, with reduced confidence', () => {
    const r = interpretRelocation(
      'We offer a relocation package for senior hires. Relocation is not available for this role.',
    );
    expect(r.value).toBe('explicit_no');
    expect(r.confidence).toBe('medium');
  });

  it('unknown stays unknown', () => {
    expect(interpretRelocation('Great team, great product.')).toEqual({
      value: 'unclear',
      confidence: 'unknown',
      evidence: [],
      basis: 'none',
    });
  });
});
