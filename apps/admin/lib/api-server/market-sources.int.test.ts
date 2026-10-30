import { lookup } from 'node:dns';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, SYSTEM_ACTOR } from '@aptamind/contracts';
import { clearEgressAttempts, egressAttempts } from '@aptamind/market/testing';
import {
  explainSourceList,
  migrateSourceNameKeys,
  migrateSourceNameTokens,
  sourceNameKey,
  sourceNameTokens,
  planStages,
  SOURCE_FRESHNESS_STATES,
  type SourceDoc,
  sourceDetailResponseDto,
  sourceDocSchema,
  sourceFreshnessState,
  sourceListQuerySchema,
  sourceListV2ResponseDto,
  sourceRunsResponseDto,
  sourceSnapshotsResponseDto,
} from '@aptamind/market';
import {
  type ApiHarness,
  expectDto,
  expectValidationError,
  mongoOrderBy,
  startApiHarness,
  traverse,
} from './market-test-harness';

/**
 * Sources list v2 (M7.4): server-computed freshness (state per row, indexed filter, the dashboard
 * overdue list), sort + keyset pagination, filters, anchored key/company search, company names,
 * and the paginated run and snapshot sub-resources.
 */

let h: ApiHarness;
let acmeId: string;
let boardId: string;
let all: SourceDoc[];
const H = 3_600_000;
const NOW = Date.now();
const PROVIDERS = ['greenhouse', 'lever', 'ashby', 'careers_page'];
const CLASSES: Array<[string, number]> = [
  ['source.ats_listing', 36 * 60], // refresh 6 h, max 36 h → fresh / due / overdue
  ['source.careers_page', 4 * 24 * 60], // refresh 1 d, max 4 d
  ['custom.unknown', 12 * 60], // unknown class: fresh / overdue only
];
// Ages well away from every boundary (the test runs for seconds, not minutes).
const AGES = [null, 1 * H, 9 * H, 30 * H, 50 * H, 5 * 24 * H];

function synthetic(i: number, companyIds: string[]): SourceDoc {
  const provider = PROVIDERS[i % 4]!;
  const [policyClass, maxAgeMinutes] = CLASSES[i % 3]!;
  const age = AGES[i % 6]!;
  const createdAt = new Date(NOW - (i % 50) * 60_000);
  return sourceDocSchema.parse({
    _id: newId('src'),
    key: `${provider}:board-${String(i).padStart(4, '0')}`,
    name: `Board ${i % 97} (${provider})`,
    category: i % 10 === 0 ? 'signal_source' : 'job_source',
    provider,
    endpoint: { boardToken: `board-${i}` },
    acquisition: { workflowKey: 'market.ats.refresh' },
    companyId: i % 5 === 0 ? companyIds[i % companyIds.length] : undefined,
    freshness: { policyClass, maxAgeMinutes },
    authority: { tier: 'official_ats' },
    enabled: i % 7 !== 0,
    health: {
      status: age === null ? 'never_run' : (['healthy', 'degraded', 'failing'] as const)[i % 3],
      consecutiveFailures: 0,
      ...(age === null ? {} : { lastSuccessAt: new Date(NOW - age) }),
    },
    schemaVersion: 1,
    createdAt,
    updatedAt: createdAt,
  });
}

beforeAll(async () => {
  h = await startApiHarness('sources');
  await h.seedSponsorRegister();
  acmeId = (await h.market.companies.col.findOne({ 'identity.normalizedName': 'acme ltd' }))!._id;
  boardId = (await h.seedGreenhouseBoard(acmeId))._id;
  const others = await h.market.companies.col.find({ status: 'active' }).limit(5).toArray();
  await h.market.sources.col.insertMany(
    Array.from({ length: 600 }, (_, i) =>
      synthetic(
        i,
        others.map((c) => c._id),
      ),
    ),
  );
  // The synthetic rows are written without `nameKey`/`nameTokens` (as before the fields existed):
  // the platform migrations (013, 2026-09-30-004) backfill them, idempotently. Widen phase: the
  // token backfill leaves `nameKey` as it is.
  expect((await migrateSourceNameKeys(h.market.ctx.db, 97)).updated).toBe(600);
  expect((await migrateSourceNameTokens(h.market.ctx.db, 97)).updated).toBe(600);
  expect((await migrateSourceNameTokens(h.market.ctx.db)).updated).toBe(0);
  all = await h.market.sources.col.find({}).toArray();
  expect(all.every((s) => JSON.stringify(s.nameTokens) === JSON.stringify(sourceNameTokens(s.name)))).toBe(
    true,
  );
  expect(all.every((s) => s.nameKey === sourceNameKey(s.name))).toBe(true);
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const idsOf = (rows: Array<{ _id: string }>) => rows.map((r) => r._id);

describe('GET /api/sources v2: freshness', () => {
  it('every row carries freshnessState / freshnessAgeMs computed by the policy function', async () => {
    const { rows } = await traverse<{ _id: string; freshnessState: string; freshnessAgeMs: number | null }>(
      h,
      '/api/sources?limit=200',
    );
    const now = new Date();
    const byId = new Map(all.map((s) => [s._id, s]));
    for (const row of rows) {
      const s = byId.get(row._id)!;
      expect(row.freshnessState).toBe(sourceFreshnessState(s, now));
      if (s.health.lastSuccessAt) expect(row.freshnessAgeMs).toBeGreaterThan(0);
      else expect(row.freshnessAgeMs).toBeNull();
    }
    expect(new Set(rows.map((r) => r.freshnessState))).toEqual(new Set(SOURCE_FRESHNESS_STATES));
  });

  it.each(SOURCE_FRESHNESS_STATES)(
    'freshness=%s selects exactly the sources in that state',
    async (state) => {
      const now = new Date();
      // `never_succeeded` leaves out the built-in system sources (never scheduled).
      const expected = all
        .filter((s) => sourceFreshnessState(s, now) === state)
        .filter((s) => state !== 'never_succeeded' || !s.key.startsWith('system:'))
        .map((s) => s._id);
      const { rows, first } = await traverse<{ _id: string }>(h, `/api/sources?freshness=${state}&limit=200`);
      expect(new Set(idsOf(rows))).toEqual(new Set(expected));
      expect(first.total).toBe(expected.length);
      expect(expected.length).toBeGreaterThan(0);
    },
  );

  it('freshness=never_succeeded excludes system sources, whose rows still report the state', async () => {
    const system = all.filter((s) => s.key.startsWith('system:') && !s.health.lastSuccessAt);
    expect(system.map((s) => s.key)).toContain('system:operator');
    const { rows } = await traverse<{ _id: string; key: string }>(
      h,
      '/api/sources?freshness=never_succeeded&limit=200',
    );
    expect(rows.some((r) => r.key.startsWith('system:'))).toBe(false);
    const listed = (await h.get('/api/sources?system=true&limit=200')).body as {
      items: Array<{ key: string; freshnessState: string }>;
    };
    expect(listed.items.find((s) => s.key === 'system:operator')?.freshnessState).toBe('never_succeeded');
  });

  it('the dashboard overdue list is the indexed `overdue,never_succeeded` query without system sources', async () => {
    const dash = (await h.get('/api/dashboard')).body as {
      freshness: { overdueSources: Array<{ sourceId: string; ageMs: number | null; maxAgeMs: number }> };
    };
    const { rows } = await traverse<{ _id: string }>(
      h,
      '/api/sources?freshness=overdue,never_succeeded&system=false&limit=200',
    );
    expect(new Set(dash.freshness.overdueSources.map((o) => o.sourceId))).toEqual(new Set(idsOf(rows)));
    for (const o of dash.freshness.overdueSources)
      expect(o.ageMs === null || o.ageMs > o.maxAgeMs).toBe(true);
  });
});

describe('GET /api/sources v2: sort, filters, search', () => {
  const cases: Array<[string, Array<[(s: SourceDoc) => string | Date | undefined, 1 | -1]>]> = [
    [
      'category',
      [
        [(s) => s.category, 1],
        [(s) => s.name, 1],
      ],
    ],
    [
      '-category',
      [
        [(s) => s.category, -1],
        [(s) => s.name, -1],
      ],
    ],
    ['name', [[(s) => s.name, 1]]],
    ['-lastSuccessAt', [[(s) => s.health.lastSuccessAt, -1]]],
    ['lastSuccessAt', [[(s) => s.health.lastSuccessAt, 1]]],
    ['-createdAt', [[(s) => s.createdAt, -1]]],
  ];
  it.each(cases)('sort=%s walks every source once, in order', async (sort, fields) => {
    const { rows } = await traverse<{ _id: string }>(h, `/api/sources?sort=${sort}&limit=83&count=none`);
    expect(idsOf(rows)).toEqual(mongoOrderBy(all, fields));
  });

  it('v1 default order and offset paging are unchanged (category, then name)', async () => {
    const expected = mongoOrderBy(all, [
      [(s) => s.category, 1],
      [(s) => s.name, 1],
    ]);
    const page = (await h.get('/api/sources?limit=50&offset=50')).body as {
      items: Array<{ _id: string }>;
      total: number;
    };
    expect(idsOf(page.items)).toEqual(expected.slice(50, 100));
    expect(page.total).toBe(all.length);
  });

  const check = async (query: string, predicate: (s: SourceDoc) => boolean) => {
    const expected = all.filter(predicate).map((s) => s._id);
    const { rows, first } = await traverse<{ _id: string }>(h, `/api/sources?${query}&limit=200`);
    expect(new Set(idsOf(rows))).toEqual(new Set(expected));
    expect(first.total).toBe(expected.length);
    expect(expected.length).toBeGreaterThan(0);
  };

  it('provider[], enabled, health[], category[], companyId[], system', async () => {
    await check('provider=lever,ashby', (s) => ['lever', 'ashby'].includes(s.provider));
    await check('enabled=false', (s) => !s.enabled);
    await check('health=degraded&health=failing', (s) => ['degraded', 'failing'].includes(s.health.status));
    await check('category=signal_source,company_universe', (s) =>
      ['signal_source', 'company_universe'].includes(s.category),
    );
    await check(`companyId=${acmeId}`, (s) => s.companyId === acmeId);
    await check('system=true', (s) => s.key.startsWith('system:'));
    await check(
      'system=false&provider=greenhouse&enabled=true',
      (s) => !s.key.startsWith('system:') && s.provider === 'greenhouse' && s.enabled,
    );
  });

  it('q: anchored on the key, on the key after its provider prefix, or on the company name', async () => {
    await check('q=greenhouse:board-00', (s) => s.key.startsWith('greenhouse:board-00'));
    await check('q=board-001', (s) => /^[a-z_]+:board-001/.test(s.key));
    await check('q=uk-sponsor', (s) => s.key.startsWith('uk-sponsor'));
    await check('q=operator', (s) => s.key === 'system:operator');
    // "acme" is the board token of greenhouse:acme and the name of its company.
    const acmeLike = new Set(
      (
        await h.market.companies.col.find({ status: 'active', 'identity.normalizedName': /^acme/ }).toArray()
      ).map((c) => c._id),
    );
    expect(acmeLike.has(acmeId)).toBe(true);
    await check('q=acme', (s) => s.key === 'greenhouse:acme' || acmeLike.has(s.companyId ?? ''));
  });

  it('q: every word is a prefix of a name token (any order; case, accents and punctuation ignored)', async () => {
    expect(sourceNameTokens('UK Home Office — Sponsor Register')).toEqual([
      'uk',
      'home',
      'office',
      'sponsor',
      'register',
    ]);
    const named =
      (...words: string[]) =>
      (s: SourceDoc) =>
        words.every((w) => sourceNameTokens(s.name).some((t) => t.startsWith(w)));
    await check('q=Board 5 (Lever', named('board', '5', 'lever'));
    await check('q=lever boa', named('lever', 'boa'));
    await check(`q=${encodeURIComponent('BÖARD 12')}`, named('board', '12'));
    // Word prefixes only: no match inside a word.
    expect(((await h.get('/api/sources?q=oard')).body as { total: number }).total).toBe(0);
    // A rename re-tokenises the source: "home office" finds it by two inner words.
    const renamed = await h.market.sources.update(
      all.find((s) => s.key === 'lever:board-0005')!._id,
      { name: 'UK Home Office Sponsor Register (mirror)' },
      SYSTEM_ACTOR,
    );
    expect(renamed.nameTokens).toEqual(['uk', 'home', 'office', 'sponsor', 'register', 'mirror']);
    all = await h.market.sources.col.find({}).toArray();
    await check('q=home office', (s) => named('home', 'office')(s) || s.key.startsWith('home office'));
    const found = (await h.get('/api/sources?q=office mirr')).body as { items: Array<{ _id: string }> };
    expect(idsOf(found.items)).toEqual([renamed._id]);
  });

  it('widen phase: register/rename write nameKey too, and the previous whole-name prefix still matches', async () => {
    const renamed = (await h.market.sources.col.findOne({ key: 'lever:board-0005' }))!;
    expect(renamed.nameKey).toBe(sourceNameKey(renamed.name));
    // A source the token backfill has not reached yet is still found through nameKey.
    const legacy = all.find((s) => s.key === 'ashby:board-0010')!;
    await h.market.sources.col.updateOne({ _id: legacy._id }, { $unset: { nameTokens: '' } });
    const found = (await h.get(`/api/sources?q=${encodeURIComponent(legacy.name.slice(0, 8))}&limit=200`))
      .body as { items: Array<{ _id: string }> };
    expect(idsOf(found.items)).toContain(legacy._id);
    await migrateSourceNameTokens(h.market.ctx.db);
    const specs = (await h.market.sources.col.listIndexes().toArray()).map((i) => i.name);
    expect(specs).toEqual(expect.arrayContaining(['by_name_key', 'by_name_tokens']));
  });

  it('the token backfill never overwrites a rename that lands between its read and its write', async () => {
    const target = all.find((s) => s.key === 'lever:board-0009')!;
    await h.market.sources.col.updateOne({ _id: target._id }, { $unset: { nameTokens: '' } });
    const res = await migrateSourceNameTokens(h.market.ctx.db, 500, {
      afterRead: async (ids) => {
        if (ids.includes(target._id))
          await h.market.sources.update(target._id, { name: 'Renamed Mid Backfill' }, SYSTEM_ACTOR);
      },
    });
    expect(res.updated).toBe(0); // the stale write (computed from the old name) was skipped
    const after = (await h.market.sources.col.findOne({ _id: target._id }))!;
    expect(after.nameTokens).toEqual(['renamed', 'mid', 'backfill']);
    expect(after.nameKey).toBe('renamed mid backfill');
    all = await h.market.sources.col.find({}).toArray();
  });

  it('rows carry the company name; the detail source has the same additions', async () => {
    const page = expectDto(sourceListV2ResponseDto, (await h.get(`/api/sources?companyId=${acmeId}`)).body);
    expect(page.items.map((s) => s.companyName)).toContain('Acme Ltd');
    const detail = expectDto(sourceDetailResponseDto, (await h.get(`/api/sources/${boardId}`)).body);
    expect(detail.source).toMatchObject({ companyName: 'Acme Ltd', freshnessState: 'fresh' });
  });
});

describe('GET /api/sources/:id/{runs,snapshots}', () => {
  it('snapshots page newest-first with a keyset cursor, stable when a new snapshot arrives', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/sources/${boardId}/snapshots?process=false`,
        payload: `{"jobs":[],"n":${i}}`,
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(201);
    }
    const snaps = await h.market.observations.snapshots.find({ sourceId: boardId }).toArray();
    expect(snaps).toHaveLength(7);
    let added = false;
    const { rows, first } = await traverse<{ _id: string }>(h, `/api/sources/${boardId}/snapshots?limit=2`, {
      between: async () => {
        if (added) return;
        added = true;
        await h.app.inject({
          method: 'POST',
          url: `/api/sources/${boardId}/snapshots?process=false`,
          payload: '{"jobs":[],"n":"late"}',
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expectDto(sourceSnapshotsResponseDto, first);
    expect(first.total).toBe(7);
    // The snapshot added mid-traversal is newer than the cursor: it never shows up twice or
    // displaces an older one.
    expect(idsOf(rows)).toEqual(mongoOrderBy(snaps, [[(s) => s.lastFetchedAt, -1]]));
  });

  it('runs page newest-first with offset paging and a state filter', async () => {
    const snap = (await h.market.observations.snapshots.findOne({ sourceId: boardId }))!;
    for (let i = 0; i < 2; i++) {
      const res = await h.post(`/api/sources/${boardId}/run`, { snapshotId: snap._id });
      await h.waitRun((res.body as { runId: string }).runId);
    }
    const p1 = expectDto(sourceRunsResponseDto, (await h.get(`/api/sources/${boardId}/runs?limit=2`)).body);
    const p2 = expectDto(
      sourceRunsResponseDto,
      (await h.get(`/api/sources/${boardId}/runs?limit=2&offset=2`)).body,
    );
    expect(p1.total).toBe(3);
    expect(p1.items).toHaveLength(2);
    expect(p2.items).toHaveLength(1);
    const ids = [...p1.items, ...p2.items].map((r) => r._id);
    expect(new Set(ids).size).toBe(3);
    const created = [...p1.items, ...p2.items].map((r) => r.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
    const done = expectDto(
      sourceRunsResponseDto,
      (await h.get(`/api/sources/${boardId}/runs?state=COMPLETED`)).body,
    );
    expect(done.total).toBe(3);
    expect((await h.get('/api/sources/src_missing/runs')).status).toBe(404);
    expect((await h.get('/api/sources/src_missing/snapshots')).status).toBe(404);
  });
});

describe('GET /api/sources v2: validation and index use', () => {
  it.each([
    ['bad freshness', '/api/sources?freshness=stale'],
    ['unsupported sort', '/api/sources?sort=key'],
    ['bad provider', '/api/sources?provider=Green House'],
    ['bad system flag', '/api/sources?system=maybe'],
    ['bad health in a list', '/api/sources?health=healthy,ok'],
    ['snapshots: after with offset', `/api/sources/src_x/snapshots?after=x&offset=2`],
    ['snapshots: unknown sort', `/api/sources/src_x/snapshots?sort=size`],
    ['runs: bad state', `/api/sources/src_x/runs?state=DONE`],
    ['runs: unknown parameter', `/api/sources/src_x/runs?after=x`],
  ])('400: %s', async (_name, url) => {
    expectValidationError(await h.get(url));
  });

  it('a search cut at the 100-character bound never yields an invalid pattern (200, not 500)', async () => {
    // 99 letters + '.': escaping before truncating left a lone trailing backslash.
    const q = encodeURIComponent(`${'a'.repeat(99)}.`);
    for (const path of ['/api/sources', '/api/companies', '/api/jobs']) {
      const res = await h.get(`${path}?q=${q}`);
      expect(res.status, path).toBe(200);
    }
  });

  it('pages and freshness filters are index-backed', async () => {
    const db = h.market.ctx.db;
    const q = (query: Record<string, string | undefined>) => sourceListQuerySchema.parse(query);
    const cursor = ((await h.get('/api/sources?sort=-lastSuccessAt&limit=40')).body as { nextCursor: string })
      .nextCursor;
    for (const query of [
      {},
      { sort: 'name' },
      { sort: '-lastSuccessAt', after: cursor },
      { sort: 'createdAt' },
    ]) {
      const stages = planStages(await explainSourceList(db, q(query), new Date()));
      expect(stages).toContain('IXSCAN');
      expect(stages).not.toContain('COLLSCAN');
      expect(stages).not.toContain('SORT');
    }
    for (const query of [
      { freshness: 'overdue' },
      { freshness: 'due,fresh' },
      { q: 'acme' },
      { provider: 'lever' },
    ]) {
      const stages = planStages(await explainSourceList(db, q(query), new Date()));
      expect(stages).toContain('IXSCAN');
      expect(stages).not.toContain('COLLSCAN');
    }
  });
});

describe('upload-only sources (company directory)', () => {
  it('generic run routes cannot bypass the upload-only rules (400)', async () => {
    const created = await h.post('/api/sources', {
      key: 'directory:route-guard',
      name: 'Route guard directory',
      category: 'company_universe',
      provider: 'company_directory',
      acquisition: {
        workflowKey: 'market.company_directory.import',
        config: { columns: { name: 'Company' } },
      },
      freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
    });
    expect(created.status).toBe(201);
    const id = (created.body as { source: { _id: string; authority: { tier: string } } }).source._id;
    expect((created.body as { source: { authority: { tier: string } } }).source.authority.tier).toBe(
      'third_party',
    );
    for (const [url, payload] of [
      ['/api/workflows/market.uk_sponsor_register.import/runs', { input: { sourceId: id } }],
      ['/api/workflows/market.ats.refresh/runs', { input: { sourceId: id, snapshotId: 'snap_x' } }],
      ['/api/workflows/market.company_directory.import/runs', { input: { sourceId: id } }],
      [`/api/sources/${id}/run`, {}],
    ] as const) {
      const res = await h.post(url, payload);
      expect(res.status, url).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('validation_failed');
    }
  });

  it('rv8 canary: the reviewer rows (spelled-dot .co emails, LinkedIn slugs) reach no API response', async () => {
    const created = await h.post('/api/sources', {
      key: 'directory:rv8-api-canary',
      name: 'rv8 API canary directory',
      category: 'company_universe',
      provider: 'company_directory',
      acquisition: {
        workflowKey: 'market.company_directory.import',
        config: { columns: { name: 'Company', legalName: 'Legal', domain: 'Domain', careersUrl: 'Careers' } },
      },
      freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
    });
    const id = (created.body as { source: { _id: string } }).source._id;
    const csv = [
      'Company,Legal,Domain,Careers',
      'zqu1 at acme dot co,,zqu1-co.co.uk,',
      '"Jane zqu2 [at] acme dot co Trading",,zqu2-co.co.uk,',
      'zqu3 arroba acme dot co,,zqu3-co.co.uk,',
      'Clean Sa Ltd,zqu4 at mail dot acme dot co,clean-sa.co.uk,',
      'Clean Sb Ltd,,clean-sb.co.uk,https://sb.co.uk/careers/zqu5-at-acme-dot-co',
      'Clean Sc Ltd,,clean-sc.co.uk,https://www.linkedin.com/jobs/view/zqu6-at-acme-dot-com-3912345678',
      'Clean Sd Ltd,,clean-sd.co.uk,https://www.linkedin.com/company/07700900766',
      'Clean Se Ltd,,clean-se.co.uk,https://www.linkedin.com/jobs/view/call-07700-900-877-3912345678',
    ].join('\n');
    await h.uploadAndProcess(id, Buffer.from(csv), 'text/csv');
    const markers = ['zqu1', 'zqu2', 'zqu3', 'zqu4', 'zqu5', 'zqu6', '07700900766', '900-877'];
    const { rows } = await traverse<{ _id: string }>(h, '/api/companies?sort=name&limit=100&count=none');
    expect(rows.map((r) => r._id)).not.toHaveLength(0);
    const bodies = [JSON.stringify(rows)];
    for (const r of rows.filter((x) => JSON.stringify(x).includes('Clean S')))
      bodies.push(JSON.stringify((await h.get(`/api/companies/${r._id}`)).body));
    // The markers hold a `u`: never in a ULID (Crockford base32) or a hex id. Id-shaped tokens are
    // stripped too, so a digit marker cannot match inside a random id either.
    const text = bodies
      .join('\n')
      .toLowerCase()
      .replace(/\b[0-9a-hjkmnp-tv-z]{26}\b|\b[0-9a-f]{24}\b|\b[0-9a-f]{64}\b/g, '<id>');
    expect(markers.filter((m) => text.includes(m))).toEqual([]);
    expect(text).toContain('clean sa ltd');
  });

  it('an upload over the source ceiling is refused from its length (413) before the body is read or stored', async () => {
    const created = await h.post('/api/sources', {
      key: 'directory:size-guard',
      name: 'Size guard directory',
      category: 'company_universe',
      provider: 'company_directory',
      acquisition: {
        workflowKey: 'market.company_directory.import',
        config: { columns: { name: 'Company' }, maxBytes: 1024 },
      },
      freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
    });
    const id = (created.body as { source: { _id: string } }).source._id;
    const big = `Company\n${'Acme Ltd\n'.repeat(500)}`;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/sources/${id}/snapshots?process=false`,
      payload: big,
      headers: { 'content-type': 'text/csv' },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: 'limit_exceeded' } });
    expect(await h.market.observations.snapshots.countDocuments({ sourceId: id })).toBe(0);
    const ok = await h.app.inject({
      method: 'POST',
      url: `/api/sources/${id}/snapshots?process=false`,
      payload: 'Company\nAcme Ltd\n',
      headers: { 'content-type': 'text/csv' },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('POST /api/sources: job-source providers are a closed, case-normalised set (PR #11 re-verify #7 LOW-1)', () => {
  const body = (provider: string, key: string, tier = 'official_ats') => ({
    key,
    name: `provider ${key}`,
    category: 'job_source',
    provider,
    endpoint: { boardToken: key },
    acquisition: { workflowKey: 'market.ats.refresh' },
    freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
    authority: { tier, listingIsComplete: true },
    governance: { accessMethod: 'public_api' },
  });

  it('an aggregator under another spelling, or an unknown provider, is refused with an authoritative tier', async () => {
    for (const [provider, key] of [
      ['Aggregator', 'lo1-agg-case'],
      ['aggregator ', 'lo1-agg-space'],
      ['adzuna-feed', 'lo1-adzuna'],
    ] as const) {
      const res = await h.post('/api/sources', body(provider, key));
      expectValidationError(res);
      expect(await h.market.sources.getByKey(key)).toBeNull();
    }
    // An unknown job-source provider is refused whatever its tier.
    expectValidationError(await h.post('/api/sources', body('adzuna-feed', 'lo1-adzuna-tp', 'third_party')));
  });

  it('the provider is stored trimmed and lower-cased', async () => {
    const res = await h.post('/api/sources', body(' Greenhouse ', 'lo1-gh-case'));
    expect(res.status).toBe(201);
    expect((res.body as { source: { provider: string } }).source.provider).toBe('greenhouse');
    const agg = await h.post('/api/sources', body(' AGGREGATOR', 'lo1-agg-tp', 'third_party'));
    expect(agg.status).toBe(201);
    expect((agg.body as { source: { provider: string } }).source.provider).toBe('aggregator');
  });
});

describe('the Market egress guard is installed for the API route tests (PR #11 re-verify #7 LOW-3)', () => {
  it('a lookup through a named node:dns import is refused and recorded', async () => {
    const err = await new Promise<Error | null>((resolve) =>
      lookup('egress-canary.example.com', (e) => resolve(e)),
    );
    expect(err?.message).toContain('EGRESS BLOCKED');
    expect(egressAttempts()).toContain('dns egress-canary.example.com');
    clearEgressAttempts(); // provoked on purpose; `close()` asserts nothing else was attempted
  });
});
