import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKET_FIXTURES_DIR } from '../../../fixtures';
import { classifyRoute, keepEvidenceRows } from './adapter';
import { nlIndRegisterAdapter } from './nl-ind';
import { ukSponsorRegisterAdapter } from './uk';
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

describe('real-file gate: UK register of licensed sponsors: workers (2026-10-30, wave 7)', () => {
  // Trimmed: one row per published route, the two published duplicate shapes and one name the
  // publication itself carries mis-encoded. Full file: 143,198 rows, 18 routes, 0 skipped.
  const parsed = ukSponsorRegisterAdapter.parse(read('uk-sponsor', 'real-register-workers-2026-10-30.csv'));
  const route = (r: string) => classifyRoute(ukSponsorRegisterAdapter, r);
  it('parses every published row (leading spaces, quoted names, trailing-space routes)', () => {
    expect(parsed.format).toBe('csv');
    expect(parsed.skipped).toEqual([]);
    expect(parsed.rows).toHaveLength(23);
    expect(parsed.rows.map((r) => r.name)).toContain('AaruvikA Limited');
    expect(parsed.rows.map((r) => r.name)).toContain('"K" Line Energy Shipping (UK) Limited');
    expect(parsed.rows.every((r) => r.route === r.route.trim())).toBe(true);
  });
  it('ignores exactly the three uk-routes/1 routes; every other published route stays labour', () => {
    const { kept, routes } = keepEvidenceRows(ukSponsorRegisterAdapter, parsed.rows);
    const ignored = routes
      .filter((r) => r.meaning === 'ignored')
      .map((r) => r.id)
      .sort();
    expect(ignored).toEqual(['government_authorised_exchange', 'international_agreement', 'seasonal_worker']);
    expect(kept).toHaveLength(20);
    for (const r of ['Skilled Worker', 'Global Business Mobility: Senior or Specialist Worker', 'Scale-up'])
      expect(route(r).meaning).toBe('labour');
  });
  it('maps every kept row to an observation; case/space variants of one organisation share a row key', () => {
    const { kept } = keepEvidenceRows(ukSponsorRegisterAdapter, parsed.rows);
    const obs = kept.map((r) => ukSponsorRegisterAdapter.toObservation(r));
    expect(obs.every((o) => o !== null)).toBe(true);
    const key = (n: string) => obs.find((o) => o!.payload.name === n)!.externalId;
    expect(key('186 LONDON LIMITED')).toBe(key('186 London Limited'));
    expect(key('2 degrees Limited')).toBe(key('2 Degrees Limited'));
  });
  it('keeps a name the publication mis-encodes as published (never repaired or guessed)', () => {
    expect(parsed.rows.some((r) => r.name === '???£ ESS LTD')).toBe(true);
  });
});
