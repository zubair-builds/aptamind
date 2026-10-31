import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKET_FIXTURES_DIR } from '../../../fixtures';
import { classifyRoute } from './adapter';
import { nlIndRegisterAdapter } from './nl-ind';
import { usH1bEmployerDataHubAdapter } from './us-h1b';

/**
 * Real-file gates (integration.gates, DECISION_LOG 14d07ad (9)): trimmed recorded copies of the
 * live publications, fetched 2026-10-30. Full files were verified on the box (no database).
 */
const read = (...p: string[]) => new Uint8Array(readFileSync(path.join(MARKET_FIXTURES_DIR, ...p)));

describe('real-file gate: NL IND public register Work (2026-10)', () => {
  const parsed = nlIndRegisterAdapter.parse(read('nl-ind', 'real-register-work-2026-10.html'));
  it('reads every row as the labour register (explanatory h2 is not the route; h1 is)', () => {
    expect(parsed.format).toBe('html_table');
    expect(parsed.rows).toHaveLength(25);
    expect(parsed.skipped).toEqual([]);
    for (const r of parsed.rows) {
      expect(classifyRoute(nlIndRegisterAdapter, r.route)).toMatchObject({
        id: 'regular_labour_highly_skilled',
        meaning: 'labour',
      });
      expect(r.identity).toMatch(/^\d{8}$/);
      expect(nlIndRegisterAdapter.toObservation(r)).not.toBeNull();
    }
  });
  it('keeps UTF-8 names and leading-zero KvK numbers as published', () => {
    const names = parsed.rows.map((r) => r.name);
    expect(names).toContain('361° Europe B.V.');
    expect(names.some((n) => /Sàrl/.test(n))).toBe(true);
    expect(parsed.rows.find((r) => r.name === '247HAIR')?.identity).toBe('02076358');
  });
});

describe('real-file gate: USCIS H-1B Employer Data Hub FY2023 export (legacy shape)', () => {
  const parsed = usH1bEmployerDataHubAdapter.parse(read('us-h1b', 'real-h1b-datahubexport-2023-trimmed.csv'));
  it('parses the legacy columns, skips the unnamed row, sums same-key rows', () => {
    expect(parsed.format).toBe('csv');
    expect(parsed.skipped).toEqual([expect.objectContaining({ reason: 'no_name' })]);
    expect(parsed.rows.every((r) => r.history?.fiscalYear === 2023)).toBe(true);
    const m3 = parsed.rows.filter((r) => r.name === '3M COMPANY');
    expect(m3.length).toBeGreaterThanOrEqual(2);
  });
  it('a row without a state yields no observation (fail closed; ~7% of the real FY2023 rows)', () => {
    const noState = parsed.rows.filter((r) => !r.county);
    expect(noState.length).toBeGreaterThan(0);
    for (const r of noState) expect(usH1bEmployerDataHubAdapter.toObservation(r)).toBeNull();
    const withState = parsed.rows.filter((r) => r.county);
    expect(withState.every((r) => usH1bEmployerDataHubAdapter.toObservation(r) !== null)).toBe(true);
  });
});
