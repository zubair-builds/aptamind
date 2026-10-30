import { describe, expect, it } from 'vitest';
import { extractResponsibilities } from './responsibilities';

describe('extractResponsibilities', () => {
  const text = `About us
We build and ship the best observability platform, used by thousands of customers.

What you'll do
- Design scalable, distributed systems and set technical direction
- Write high-quality code and ship features every week
- Own services end-to-end, including the on-call rotation
- Mentor engineers across the team
- Hire and grow the team, running performance reviews
- Work closely with product managers and designers

Benefits
- Home office budget`;

  const r = extractResponsibilities(text);

  it('detects every signal from the responsibilities section with evidence', () => {
    for (const signal of Object.values(r)) expect(signal.present).toBe(true);
    expect(r.architecture.evidence[0]?.quote).toBe(
      'Design scalable, distributed systems and set technical direction',
    );
    expect(r.operationalResponsibility.evidence[0]?.quote).toBe(
      'Own services end-to-end, including the on-call rotation',
    );
    for (const signal of Object.values(r)) {
      for (const e of signal.evidence) expect(text.slice(e.start ?? 0, e.end)).toBe(e.quote);
    }
  });

  it('ignores company blurbs when a responsibilities section exists', () => {
    expect(r.implementation.evidence.every((e) => !/observability platform/.test(e.quote))).toBe(true);
  });

  it('does not treat end-to-end tests as ownership', () => {
    const t = extractResponsibilities('Responsibilities\n- Write automated end-to-end tests');
    expect(t.ownership.present).toBe(false);
    expect(t.implementation.present).toBe(true);
  });

  it('returns all-false signals for empty text', () => {
    const empty = extractResponsibilities('');
    expect(Object.values(empty).every((s) => !s.present && s.evidence.length === 0)).toBe(true);
  });
});
