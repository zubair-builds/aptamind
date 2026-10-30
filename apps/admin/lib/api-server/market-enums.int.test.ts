import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAREERS_DISCOVERY_STATUSES,
  EMPLOYMENT_TYPES,
  JOB_STATES,
  MARKET_ENUMS,
  RELOCATION_STATUSES,
  REMOTE_SCOPE_TYPES,
  REVIEW_ACTIONS,
  REVIEW_TYPES,
  SENIORITY_LEVELS,
  SOURCE_FRESHNESS_STATES,
  SOURCE_HEALTH_STATUSES,
  SPONSORSHIP_STATUSES,
  WORK_MODELS,
} from '@aptamind/market';
import { AUTHORITY_TIERS, CONFIDENCE_LEVELS, FACT_STATUSES } from '@aptamind/provenance';
import { RUN_STATES } from '@aptamind/workflows';
import { type ApiHarness, expectDto, expectValidationError, startApiHarness } from './market-test-harness';
import { CORE_ENUMS, ENUM_CATALOGS, enumsQuerySchema, enumsResponseDto } from './routes/meta';

/** `GET /api/meta/enums` (API-10, M7.7): Market enums with labels, from the Market constants. */

let h: ApiHarness;

beforeAll(async () => {
  h = await startApiHarness('enums');
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('GET /api/meta/enums', () => {
  it('serves every Market enum with a label per value, exactly the constants the API validates with', async () => {
    const res = await h.get('/api/meta/enums');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    const { enums } = expectDto(enumsResponseDto, res.body);
    expect(enums).toEqual(JSON.parse(JSON.stringify({ ...CORE_ENUMS, ...MARKET_ENUMS })));
    // Foundation enums are the core catalog, built from the Foundation constants.
    const core = (name: string) => enums[`core.${name}`]!.values.map((v) => v.value);
    expect(core('factStatus')).toEqual([...FACT_STATUSES]);
    expect(core('confidenceLevel')).toEqual([...CONFIDENCE_LEVELS]);
    expect(core('authorityTier')).toEqual([...AUTHORITY_TIERS]);
    expect(core('runState')).toEqual([...RUN_STATES]);
    expect(Object.keys(MARKET_ENUMS).every((k) => k.startsWith('market.'))).toBe(true);
    const values = (name: string) => enums[`market.${name}`]!.values.map((v) => v.value);
    expect(values('jobState')).toEqual([...JOB_STATES]);
    expect(values('workModel')).toEqual([...WORK_MODELS]);
    expect(values('remoteScope')).toEqual([...REMOTE_SCOPE_TYPES]);
    expect(values('sponsorship')).toEqual([...SPONSORSHIP_STATUSES]);
    expect(values('relocation')).toEqual([...RELOCATION_STATUSES]);
    expect(values('employmentType')).toEqual([...EMPLOYMENT_TYPES]);
    expect(values('seniority')).toEqual([...SENIORITY_LEVELS]);
    expect(values('careersDiscoveryStatus')).toEqual([...CAREERS_DISCOVERY_STATUSES]);
    expect(values('sourceHealth')).toEqual([...SOURCE_HEALTH_STATUSES]);
    expect(values('sourceFreshness')).toEqual([...SOURCE_FRESHNESS_STATES]);
    expect(values('reviewType')).toEqual([...REVIEW_TYPES]);
    expect(values('reviewAction')).toEqual([...REVIEW_ACTIONS]);
    for (const [name, e] of Object.entries(enums)) {
      expect(new Set(e.values.map((v) => v.value)).size, name).toBe(e.values.length);
      for (const v of e.values) expect(v.label.trim().length, `${name}.${v.value}`).toBeGreaterThan(0);
    }
    // The Market capability axis: `historical` is historical sponsorship evidence, never the
    // "Previously licensed" label (reserved for the company licence value).
    const historical = enums['market.sponsorshipCompanyCapability']!.values.find(
      (v) => v.value === 'historical',
    )!;
    expect(historical.label).toBe('Sponsorship history');
    expect(historical.label).not.toMatch(/licen[cs]ed/i);
    const none = (name: string) => enums[`market.${name}`]!.values.find((v) => v.value === 'none')!.label;
    expect(none('licenceStatus')).toBe(none('sponsorshipCompanyCapability'));
    const yes = enums['market.sponsorship']!.values.find((v) => v.value === 'explicit_yes')!;
    // PR #21: explicit values are operator assertions; posting text is only a statement flag.
    expect(yes.description).toMatch(/posting text never yields it \(see flag sponsorship_stated\)/);
    // M6.2 MR4: posting text never yields either explicit value — not "alone", not at all.
    const no = enums['market.sponsorship']!.values.find((v) => v.value === 'explicit_no')!;
    for (const v of [yes, no]) {
      expect(v.description).toMatch(/posting text never yields it \(see flag sponsorship_stated\)/);
      expect(v.description).not.toMatch(/alone/);
    }
    expect(yes.description).not.toMatch(/sponsorship_conditional/);
    const lapsed = enums['market.sponsorshipCompanyCapability']!.values.find(
      (v) => v.value === 'previously_licensed',
    )!;
    expect(lapsed.label).toBe('Previously licensed');
    // Hiring history (M11.5 ruling): "Sponsorship history", never "Sponsored before".
    const history = enums['market.sponsorship']!.values.find((v) => v.value === 'historical_evidence')!;
    expect(history.label).toBe('Sponsorship history');
    expect(history.description).toMatch(/not a current licence and not about this role/);
    for (const e of Object.values(enums))
      for (const v of e.values) expect(v.label).not.toMatch(/sponsored before/i);
    // The label that must never read as "sponsors".
    const capable = enums['market.sponsorship']!.values.find((v) => v.value === 'company_capable')!;
    expect(capable.label.toLowerCase()).not.toMatch(/sponsors|yes/);
    expect(capable.description).toMatch(/not "this job sponsors"/i);
  });

  it('every enum a list filter accepts is served (filters validated with the same values)', async () => {
    const { enums } = expectDto(enumsResponseDto, (await h.get('/api/meta/enums?domain=market')).body);
    // A value from the catalog is accepted by the filter it names; a value outside it is a 400.
    for (const [name, param, path] of [
      ['workModel', 'workModel', '/api/jobs'],
      ['sponsorship', 'sponsorship', '/api/jobs'],
      ['jobState', 'state', '/api/jobs'],
      ['careersDiscoveryStatus', 'careersStatus', '/api/companies'],
      ['licenceStatus', 'licenceStatus', '/api/companies'],
      ['sourceHealth', 'health', '/api/sources'],
      ['sourceFreshness', 'freshness', '/api/sources'],
      ['reviewType', 'type', '/api/review'],
      ['reviewSeverity', 'severity', '/api/review'],
    ] as const) {
      const all = enums[`market.${name}`]!.values.map((v) => v.value).join(',');
      expect((await h.get(`${path}?${param}=${all}&limit=1`)).status, name).toBe(200);
      expectValidationError(await h.get(`${path}?${param}=not_a_value&limit=1`));
      expect(
        enums[`market.${name}`]!.appliesTo.some((a) => a.includes(`${path}?${param}`)),
        name,
      ).toBe(true);
    }
  });

  it('?domain= accepts exactly the registered catalogs', async () => {
    expect(Object.keys(ENUM_CATALOGS).sort()).toEqual(['core', 'market']);
    for (const d of Object.keys(ENUM_CATALOGS)) {
      expect(enumsQuerySchema.safeParse({ domain: d }).success).toBe(true);
      const { enums } = expectDto(enumsResponseDto, (await h.get(`/api/meta/enums?domain=${d}`)).body);
      expect(Object.keys(enums).every((k) => k.startsWith(`${d}.`))).toBe(true);
      expect(Object.keys(enums)).toEqual(Object.keys(ENUM_CATALOGS[d]!));
    }
  });

  it('400 on an unknown domain or parameter', async () => {
    expectValidationError(await h.get('/api/meta/enums?domain=professional'));
    expectValidationError(await h.get('/api/meta/enums?lang=de'));
  });
});
