import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKET_FIXTURES_DIR } from '../../../fixtures';
import { IDENTITY_NAMESPACE_DEFINITIONS, normalizeIdentity } from '../../../companies/external-ids';
import { sponsorRowToPayload } from '../uk-sponsor-register';
import { registerEndpointOf } from '../../../workflow-nodes/registers';
import {
  classifyRoute,
  nlIndRegisterAdapter,
  NL_IND_LABOUR_REGISTER_URL,
  NL_IND_PUBLICATION_URL,
  NO_OWN_HEADING,
  REGISTER_ADAPTERS,
  RegisterFormatError,
  registerAdapterForProvider,
  ukSponsorRegisterAdapter,
  historyShrinkReviewKey,
  planHistoryPeriods,
  usH1bEmployerDataHubAdapter,
  usStateCode as usH1bStateOf,
} from '.';

const fixture = (...p: string[]) => readFileSync(path.join(MARKET_FIXTURES_DIR, ...p));

describe('register adapter registry', () => {
  it('has one adapter per register id and per source provider', () => {
    expect(new Set(REGISTER_ADAPTERS.map((a) => a.id)).size).toBe(REGISTER_ADAPTERS.length);
    expect(new Set(REGISTER_ADAPTERS.map((a) => a.provider)).size).toBe(REGISTER_ADAPTERS.length);
    expect(registerAdapterForProvider(' NL_IND_Recognised_Sponsors ')).toBe(nlIndRegisterAdapter);
    expect(registerAdapterForProvider('greenhouse')).toBeNull();
  });

  it('declares a scope country and, for capability registers, every taxonomy route a meaning', () => {
    for (const a of REGISTER_ADAPTERS) {
      expect(a.scope.country).toMatch(/^[A-Z]{2}$/);
      for (const r of a.routes) expect(['labour', 'history', 'ignored']).toContain(r.meaning);
      // A capability register never produces history, and vice versa.
      if (a.evidenceTier === 'capability') expect(a.routes.some((r) => r.meaning === 'history')).toBe(false);
      if (a.evidenceTier === 'history') {
        expect(a.routes.some((r) => r.meaning === 'labour')).toBe(false);
        expect(a.unlistedRouteMeaning).toBe('ignored');
      }
    }
  });
});

describe('UK register adapter (M2 mapping; M8.4b route taxonomy)', () => {
  it('maps every fixture row exactly as the M2 workflow mapping does', () => {
    const parsed = ukSponsorRegisterAdapter.parse(fixture('uk-sponsor', 'register-t1.csv'));
    expect(parsed.format).toBe('csv');
    expect(parsed.rows).toHaveLength(23);
    expect(parsed.skipped.map((s) => s.reason)).toEqual(['no_name', 'no_route']);
    for (const row of parsed.rows) {
      // M8.4b: Government Authorised Exchange is ignored; every other fixture route stays labour.
      expect(classifyRoute(ukSponsorRegisterAdapter, row.route).meaning).toBe(
        row.route === 'Government Authorised Exchange' ? 'ignored' : 'labour',
      );
      expect(ukSponsorRegisterAdapter.toObservation(row)).toEqual(sponsorRowToPayload(row));
    }
    const acme = ukSponsorRegisterAdapter.toObservation(parsed.rows[0]!);
    expect(acme).toMatchObject({
      externalId: 'acme ltd|london|skilled worker',
      payload: { sponsorLicence: { register: 'uk_home_office_licensed_sponsors_workers', country: 'GB' } },
    });
  });

  it('M8.4b: ignores exactly the three Temporary Worker routes; unlisted routes stay labour', () => {
    for (const r of [
      'Government Authorised Exchange',
      'Seasonal Worker',
      'International Agreement',
      'temporary worker - seasonal worker',
    ])
      expect(classifyRoute(ukSponsorRegisterAdapter, r).meaning, r).toBe('ignored');
    for (const r of [
      'Skilled Worker',
      'Global Business Mobility: Senior or Specialist Worker',
      'Creative Worker',
      'Charity Worker',
      'Scale-up',
      'Seasonal Worker Pilot Extension',
    ])
      expect(classifyRoute(ukSponsorRegisterAdapter, r).meaning, r).toBe('labour');
  });

  it('refuses an HTML page and a CSV without the register columns', () => {
    expect(() => ukSponsorRegisterAdapter.parse(fixture('uk-sponsor', 'publication-page.html'))).toThrow(
      RegisterFormatError,
    );
    expect(() => ukSponsorRegisterAdapter.parse(Buffer.from('Name,Town\nAcme,London\n'))).toThrow(
      RegisterFormatError,
    );
  });
});

describe('NL IND register adapter', () => {
  it('reads the register table: organisation, KvK number, route from the page heading', () => {
    const parsed = nlIndRegisterAdapter.parse(fixture('nl-ind', 'register-labour-t1.html'));
    expect(parsed.format).toBe('html_table');
    expect(parsed.rows).toHaveLength(8);
    expect(parsed.rows[0]).toEqual({
      locator: 'table:1/row:1',
      name: 'Voorbeeld Tech B.V.',
      route: 'Public register regular labour and highly skilled migrants',
      identity: '99000011',
    });
    const obs = nlIndRegisterAdapter.toObservation(parsed.rows[0]!);
    expect(obs).toEqual({
      externalId: 'kvk:99000011|regular_labour_highly_skilled',
      payload: {
        name: 'Voorbeeld Tech B.V.',
        legalName: 'Voorbeeld Tech B.V.',
        aliases: [],
        externalIds: [{ namespace: 'nl_kvk', id: '99000011' }],
        locations: [],
        industries: [],
        sponsorLicence: {
          register: 'nl_ind_recognised_sponsors',
          country: 'NL',
          route: 'Regular labour and highly skilled migrants',
          typeRating: null,
          town: null,
          county: null,
        },
      },
    });
  });

  it('uses the KvK number as identity when listed, the name rules otherwise (placeholder ids count as absent)', () => {
    const rows = nlIndRegisterAdapter.parse(fixture('nl-ind', 'register-labour-t1.html')).rows;
    const byName = (n: string) => nlIndRegisterAdapter.toObservation(rows.find((r) => r.name === n)!)!;
    expect(byName('Grachtengordel Data B.V.').payload.externalIds).toEqual([]);
    expect(byName('Grachtengordel Data B.V.').externalId).toBe(
      'name:grachtengordel data b v|regular_labour_highly_skilled',
    );
    expect(byName('Dijkstra & Zonen Logistiek B.V.').payload.externalIds).toEqual([
      { namespace: 'nl_kvk', id: '99000044' },
    ]);
    expect(byName('Polderlicht Energy B.V.').payload.externalIds).toEqual([]);
    expect(normalizeIdentity('nl_kvk', '1234567')).toBeNull();
    // One repeated digit is a placeholder (directory ruling).
    expect(normalizeIdentity('nl_kvk', '11111111')).toBeNull();
    expect(normalizeIdentity('nl_kvk', '9999 9999')).toBeNull();
    expect(IDENTITY_NAMESPACE_DEFINITIONS.nl_kvk.kind).toBe('register_id');
    expect(IDENTITY_NAMESPACE_DEFINITIONS.uk_sponsor_register.kind).toBe('row_identity');
    expect(normalizeIdentity('nl_kvk', '12.34.56.78')).toBe('12345678');
  });

  it('keeps labour routes only: study, au pair, exchange and unrecognised registers are never evidence', () => {
    const parsed = nlIndRegisterAdapter.parse(fixture('nl-ind', 'register-all-purposes.html'));
    const classified = parsed.rows.map((r) => ({
      name: r.name,
      ...classifyRoute(nlIndRegisterAdapter, r.route),
    }));
    expect(classified.map((c) => [c.name, c.id, c.meaning])).toEqual([
      ['Molenwerk Software B.V.', 'regular_labour_highly_skilled', 'labour'],
      ['Tulpenveld Research Institute', 'research', 'labour'],
      ['Universiteit van Voorbeeldstad', 'research', 'labour'],
      ['Havenkraan Engineering N.V.', 'eu_blue_card', 'labour'],
      ['Universiteit van Voorbeeldstad', 'study', 'ignored'],
      ['Taalschool Noord B.V.', 'study', 'ignored'],
      ['Au Pair Bureau Zonnebloem B.V.', 'exchange', 'ignored'],
      ['Kasgroen Tuinbouw B.V.', null, 'ignored'],
    ]);
    const evidence = parsed.rows.map((r) => nlIndRegisterAdapter.toObservation(r));
    expect(evidence.map((e) => e?.payload.sponsorLicence?.route ?? null)).toEqual([
      'Regular labour and highly skilled migrants',
      'Researchers (Directive (EU) 2016/801)',
      'Researchers (Directive (EU) 2016/801)',
      'EU Blue Card',
      null,
      null,
      null,
      null,
    ]);
    // Every licence is for the register's own country.
    for (const e of evidence) if (e) expect(e.payload.sponsorLicence?.country).toBe('NL');
  });

  it('classifies routes fail-closed: labour only by an exact alias; a resemblance is ignored and unlisted', () => {
    const meaning = (s: string) => classifyRoute(nlIndRegisterAdapter, s);
    expect(meaning('Kennismigranten')).toMatchObject({
      id: 'regular_labour_highly_skilled',
      meaning: 'labour',
    });
    expect(meaning('HIGHLY-SKILLED MIGRANTS (register)')).toMatchObject({ id: null, meaning: 'ignored' });
    expect(meaning('Arbeid regulier (pilot)')).toMatchObject({ id: null, meaning: 'ignored' });
    // Review probes (DECISION_LOG "Sponsor register adapters" (1)).
    expect(meaning('Seasonal labour')).toMatchObject({ id: 'seasonal_labour', meaning: 'ignored' });
    expect(meaning('Public register seasonal labour pilot')).toMatchObject({ id: null, meaning: 'ignored' });
    expect(meaning('Stagiair arbeid in loondienst')).toMatchObject({ id: 'trainee', meaning: 'ignored' });
    expect(meaning('Intra-corporate transferees')).toMatchObject({ id: 'intra_corporate_transfer' });
    expect(meaning('Zoekjaar hoogopgeleiden')).toMatchObject({ id: 'orientation_year', meaning: 'ignored' });
    // Delta review A-M1: researcher and Blue Card spellings (prefix and directive reference normalised).
    for (const [label, id] of [
      ['Onderzoekers', 'research'],
      ['Onderzoeker', 'research'],
      ['Public register researchers', 'research'],
      ['Public register Researchers (Directive (EU) 2016/801)', 'research'],
      ['Onderzoekers (richtlijn (EU) 2016/801)', 'research'],
      ['Openbaar register Onderzoek in de zin van richtlijn (EU) 2016/801', 'research'],
      ['Openbaar register Europese blauwe kaart', 'eu_blue_card'],
      ['Kennismigranten en Europese blauwe kaart', 'regular_labour_highly_skilled'],
      [
        'Regular labour and highly skilled migrants (including EU Blue Card)',
        'regular_labour_highly_skilled',
      ],
    ] as const)
      expect(meaning(label), label).toMatchObject({ id, meaning: 'labour' });
    expect(meaning('Openbaar register studie')).toMatchObject({ id: 'study', meaning: 'ignored' });
    expect(meaning('Studie')).toMatchObject({ id: 'study', meaning: 'ignored' });
    expect(meaning('Research and study')).toMatchObject({ id: null, meaning: 'ignored' });
    expect(meaning('Seizoensarbeid')).toMatchObject({ id: 'seasonal_labour', meaning: 'ignored' });
    expect(meaning('Public register recognised sponsors')).toMatchObject({ id: null, meaning: 'ignored' });
  });

  it('reads an operator CSV upload with a Category column, and refuses one without it', () => {
    const parsed = nlIndRegisterAdapter.parse(fixture('nl-ind', 'register-upload.csv'));
    expect(parsed.format).toBe('csv');
    expect(parsed.rows.map((r) => [r.name, r.identity, r.route])).toEqual([
      ['Voorbeeld Tech B.V.', '99000011', 'Regular labour and highly skilled migrants'],
      ['Tulpenveld Research Institute', '99000033', 'Research'],
      ['Taalschool Noord B.V.', '99000099', 'Study'],
      ['Au Pair Bureau Zonnebloem B.V.', '99000101', 'Au pair'],
      ['Grachtengordel Data B.V.', null, 'Arbeid regulier en kennismigranten'],
    ]);
    expect(parsed.skipped).toEqual([{ locator: 'row:7', reason: 'no_name' }]);
    expect(() =>
      nlIndRegisterAdapter.parse(Buffer.from('Organisation,KvK number\nX B.V.,99000011\n')),
    ).toThrow(RegisterFormatError);
    expect(() =>
      nlIndRegisterAdapter.parse(Buffer.from('<html><body><p>No table</p></body></html>')),
    ).toThrow(RegisterFormatError);
  });

  it('decodes UTF-16 and UTF-8 BOM files', () => {
    const csv = 'Organisation\tKvK number\tCategory\nVoorbeeld Tech B.V.\t99000011\tStudie\n';
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, 'utf16le')]);
    expect(nlIndRegisterAdapter.parse(utf16)).toMatchObject({ format: 'tsv', rows: [{ route: 'Studie' }] });
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv.replaceAll('\t', ','))]);
    expect(nlIndRegisterAdapter.parse(bom).rows[0]?.name).toBe('Voorbeeld Tech B.V.');
  });
});

describe('US H-1B Employer Data Hub adapter (hiring history)', () => {
  it('reads the legacy export: fiscal year, counts, state; malformed rows are skipped with a code', () => {
    const parsed = usH1bEmployerDataHubAdapter.parse(fixture('us-h1b', 'h1b-datahub-fy2023-legacy.csv'));
    expect(parsed.format).toBe('csv');
    expect(parsed.rows).toHaveLength(7);
    expect(parsed.skipped).toEqual([
      { locator: 'row:9', reason: 'no_fiscal_year' },
      { locator: 'row:10', reason: 'invalid_count' },
      // Strict for history registers: never read with shifted columns.
      { locator: 'row:11', reason: 'column_count_mismatch' },
    ]);
    expect(parsed.rows[0]).toEqual({
      locator: 'row:2',
      name: 'ACME ANALYTICS INC',
      route: 'H-1B',
      town: 'SAN FRANCISCO',
      county: 'CA',
      history: {
        fiscalYear: 2023,
        initialApprovals: 12,
        initialDenials: 1,
        continuingApprovals: 30,
        continuingDenials: 2,
        rowKey: expect.stringMatching(/^[0-9a-f]{24}$/),
      },
    });
  });

  it('reads the current UTF-16 tab-separated export: initial = new employment, continuing = the other categories', () => {
    const parsed = usH1bEmployerDataHubAdapter.parse(
      fixture('us-h1b', 'h1b-datahub-fy2024-employer-information.csv'),
    );
    expect(parsed.format).toBe('tsv');
    expect(parsed.rows.map((r) => [r.name, r.county, r.history])).toEqual([
      [
        'ACME ANALYTICS INC',
        'CA',
        {
          fiscalYear: 2024,
          initialApprovals: 10,
          initialDenials: 1,
          continuingApprovals: 8 + 2 + 1 + 6 + 3,
          continuingDenials: 1,
          rowKey: expect.stringMatching(/^[0-9a-f]{24}$/),
        },
      ],
      ['UNKNOWN WIDGETS LLC', 'WA', expect.objectContaining({ initialApprovals: 2, continuingApprovals: 2 })],
      ['HELIX BIOTECH PLC', 'MA', expect.objectContaining({ initialApprovals: 1, continuingApprovals: 0 })],
    ]);
  });

  it('maps a row to history evidence for the US only (never a licence), keyed by employer and state', () => {
    const [row] = usH1bEmployerDataHubAdapter.parse(fixture('us-h1b', 'h1b-datahub-fy2023-legacy.csv')).rows;
    const obs = usH1bEmployerDataHubAdapter.toObservation(row!)!;
    // The record key is hashed: no tax-id or ZIP digits (DECISION_LOG "Sponsor register adapters" (3)).
    expect(obs.externalId).toMatch(/^fy2023\|[0-9a-f]{24}$/);
    expect(JSON.stringify(obs)).not.toMatch(/94105|1234/);
    expect(obs.payload.sponsorLicence).toBeUndefined();
    expect(obs.payload.externalIds).toEqual([{ namespace: 'us_h1b_employer', id: 'acme analytics inc|CA' }]);
    expect(obs.payload.locations).toEqual([]);
    expect(obs.payload.sponsorshipHistory).toEqual({
      register: 'us_uscis_h1b_employer_data_hub',
      country: 'US',
      route: 'H-1B',
      fiscalYear: 2023,
      initialApprovals: 12,
      initialDenials: 1,
      continuingApprovals: 30,
      continuingDenials: 2,
      state: 'CA',
      city: 'SAN FRANCISCO',
    });
    expect(classifyRoute(usH1bEmployerDataHubAdapter, 'H-1B').meaning).toBe('history');
    // No US state: the attachment rule (exact name + state) cannot hold, so no evidence.
    expect(usH1bEmployerDataHubAdapter.toObservation({ ...row!, county: 'Ontario' })).toBeNull();
    expect(usH1bStateOf('Texas')).toBe('TX');
  });

  it('refuses files that are not a Data Hub export', () => {
    expect(() => usH1bEmployerDataHubAdapter.parse(fixture('uk-sponsor', 'register-t1.csv'))).toThrow(
      RegisterFormatError,
    );
    expect(() =>
      usH1bEmployerDataHubAdapter.parse(Buffer.from('Fiscal Year,Employer,State\n2023,X,CA\n')),
    ).toThrow(RegisterFormatError);
  });
});

describe('register endpoints', () => {
  it('an NL source without endpoint.url fetches the labour register page, never the register index', () => {
    expect(registerEndpointOf({ endpoint: {} }, nlIndRegisterAdapter)).toBe(NL_IND_LABOUR_REGISTER_URL);
    expect(registerEndpointOf({ endpoint: {} }, nlIndRegisterAdapter)).not.toBe(NL_IND_PUBLICATION_URL);
    expect(registerEndpointOf({ endpoint: { url: 'https://x.test/r' } }, nlIndRegisterAdapter)).toBe(
      'https://x.test/r',
    );
  });
});

describe('HTML register tables inherit a heading only when it is their own (fail closed)', () => {
  const routesOf = (html: string) =>
    nlIndRegisterAdapter
      .parse(Buffer.from(html))
      .rows.map((r) => [r.name, classifyRoute(nlIndRegisterAdapter, r.route).meaning]);
  const table = (name: string) =>
    `<table><tr><th>Organisation</th><th>KvK number</th></tr><tr><td>${name}</td><td></td></tr></table>`;

  it("a bold-only paragraph directly before a table is that table's own label (review repro)", () => {
    const html = `<html><body><h2>Kennismigranten</h2>${table('A B.V.')}<p><strong>Studie</strong></p>${table('Taalschool B.V.')}</body></html>`;
    expect(routesOf(html)).toEqual([
      ['A B.V.', 'labour'],
      ['Taalschool B.V.', 'ignored'],
    ]);
    expect(nlIndRegisterAdapter.parse(Buffer.from(html)).rows[1]?.route).toBe('Studie');
  });

  it('a figcaption labels its table: the figure/figcaption Study repro is ignored, not labour', () => {
    const html = `<html><body><h2>Kennismigranten</h2><figure><figcaption>Studie</figcaption>${table('Taalschool B.V.')}</figure></body></html>`;
    expect(routesOf(html)).toEqual([['Taalschool B.V.', 'ignored']]);
  });

  it('a table sharing its nearest heading with another table is ignored', () => {
    const html = `<html><body><h2>Kennismigranten</h2>${table('A B.V.')}<p>Other organisations</p>${table('Taalschool B.V.')}</body></html>`;
    expect(routesOf(html)).toEqual([
      ['A B.V.', 'ignored'],
      ['Taalschool B.V.', 'ignored'],
    ]);
    expect(nlIndRegisterAdapter.parse(Buffer.from(html)).rows[1]?.route).toBe(NO_OWN_HEADING);
  });

  it('a generic nearest heading falls back to the page h1 on a single-table page only; the title loses its site suffix', () => {
    const single = `<html><head><title>x</title></head><body><h1>Public register regular labour and highly skilled migrants</h1><h2>Recognised sponsors</h2>${table('A B.V.')}</body></html>`;
    expect(routesOf(single)).toEqual([['A B.V.', 'labour']]);
    const multi = `<html><body><h1>Kennismigranten</h1><h2>Erkende referenten</h2>${table('A B.V.')}<h2>Studie</h2>${table('B B.V.')}</body></html>`;
    expect(routesOf(multi)).toEqual([
      ['A B.V.', 'ignored'],
      ['B B.V.', 'ignored'],
    ]);
    const titled = `<html><head><title>Public register regular labour and highly skilled migrants | IND</title></head><body>${table('A B.V.')}</body></html>`;
    expect(routesOf(titled)).toEqual([['A B.V.', 'labour']]);
    // A non-generic unrecognised heading is never replaced by the h1.
    const pilot = `<html><body><h1>Kennismigranten</h1><h2>Seizoensarbeid pilot</h2>${table('A B.V.')}</body></html>`;
    expect(routesOf(pilot)).toEqual([['A B.V.', 'ignored']]);
  });

  it('a heading inside a table cell never leaks to the next table; template content is not the page', () => {
    const html = `<html><body><h2>Studie</h2><table><tr><th>Organisation</th></tr><tr><td><h3>Kennismigranten</h3>X B.V.</td></tr></table><template><h2>Kennismigranten</h2></template>${table('Y B.V.')}</body></html>`;
    // Y has no heading of its own (the h3 is in a cell, the template is not rendered): ignored.
    expect(routesOf(html)).toEqual([
      ['KennismigrantenX B.V.', 'ignored'],
      ['Y B.V.', 'ignored'],
    ]);
  });

  it('a multi-table page never lends its document heading; a single-table page does', () => {
    const multi = `<html><head><title>Public register regular labour and highly skilled migrants</title></head><body>${table('A B.V.')}${table('B B.V.')}</body></html>`;
    expect(routesOf(multi)).toEqual([
      ['A B.V.', 'ignored'],
      ['B B.V.', 'ignored'],
    ]);
    const single = `<html><head><title>Public register regular labour and highly skilled migrants</title></head><body>${table('A B.V.')}</body></html>`;
    expect(routesOf(single)).toEqual([['A B.V.', 'labour']]);
    const own = `<html><body><h2>Kennismigranten</h2>${table('A B.V.')}<h2>Studie</h2>${table('B B.V.')}</body></html>`;
    expect(routesOf(own)).toEqual([
      ['A B.V.', 'labour'],
      ['B B.V.', 'ignored'],
    ]);
  });
});

describe('H-1B rows: NAICS in the row key, summed within a file', () => {
  const csv = (rows: string[]) =>
    Buffer.from(
      [
        'Fiscal Year,Employer,Initial Approval,Initial Denial,Continuing Approval,Continuing Denial,NAICS,Tax ID,State,City,ZIP',
        ...rows,
      ].join('\n'),
    );
  it('two rows differing only by NAICS stay two rows (4 + 6 = 10), identical keys are summed', () => {
    const parsed = usH1bEmployerDataHubAdapter.parse(
      csv([
        '2022,BETA CORP,4,0,0,0,54,7777,CA,IRVINE,92618',
        '2022,BETA CORP,6,0,0,0,51,7777,CA,IRVINE,92618',
        '2022,BETA CORP,1,0,0,0,51,7777,CA,IRVINE,92618',
      ]),
    );
    expect(parsed.rows.map((r) => r.history?.initialApprovals)).toEqual([4, 7]);
    expect(parsed.summedRows).toBe(1);
    const ids = parsed.rows.map((r) => usH1bEmployerDataHubAdapter.toObservation(r)!.externalId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('history periods: per-fiscal-year shrink guard', () => {
  const rows = (fy: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      locator: `row:${i}`,
      name: `E${i}`,
      route: 'H-1B',
      history: {
        fiscalYear: fy,
        initialApprovals: 1,
        initialDenials: 0,
        continuingApprovals: 0,
        continuingDenials: 0,
      },
    }));
  const P = 'us-h1b-datahub-row/1';
  const marker = { period: 2023, completeAt: new Date(0), rowCount: 10, snapshotId: 'snap_a', parser: P };
  it('holds back a period that shrank below half of its last complete import, with the marker it read', () => {
    expect(planHistoryPeriods(rows(2023, 4), [marker], 'snap_b', P)).toEqual([
      {
        period: 2023,
        rows: 4,
        heldBack: true,
        previousRows: 10,
        confirmed: false,
        marker: { snapshotId: 'snap_a', completeAt: new Date(0).toISOString(), rowCount: 10, parser: P },
      },
    ]);
    expect(planHistoryPeriods(rows(2023, 5), [marker], 'snap_b', P)[0]?.heldBack).toBe(false);
    // Other periods and the marker's own snapshot (same parser) are never held back.
    expect(planHistoryPeriods(rows(2024, 1), [marker], 'snap_b', P)[0]).toMatchObject({
      heldBack: false,
      marker: null,
    });
    expect(planHistoryPeriods(rows(2023, 1), [marker], 'snap_a', P)[0]?.heldBack).toBe(false);
  });

  it("re-reading the marker's own snapshot with another parser version is guarded like a new file (L3)", () => {
    expect(planHistoryPeriods(rows(2023, 1), [marker], 'snap_a', 'us-h1b-datahub-row/2')[0]?.heldBack).toBe(
      true,
    );
    expect(
      planHistoryPeriods(rows(2023, 1), [{ ...marker, parser: undefined }], 'snap_a', P)[0]?.heldBack,
    ).toBe(true);
  });

  it('an operator confirmation of exactly this shrink applies it; another count stays held (B-M2)', () => {
    const plan = planHistoryPeriods(rows(2023, 4), [marker], 'snap_b', P, new Map([[2023, 4]]));
    expect(plan[0]).toMatchObject({ heldBack: false, confirmed: true });
    expect(planHistoryPeriods(rows(2023, 3), [marker], 'snap_b', P, new Map([[2023, 4]]))[0]?.heldBack).toBe(
      true,
    );
    expect(historyShrinkReviewKey('src_1', 2023, 'snap_b', { snapshotId: 'snap_a', completeAt: 'T' })).toBe(
      'source_anomaly:src_1:history_shrink:FY2023:snap_b:snap_a@T',
    );
  });
});
