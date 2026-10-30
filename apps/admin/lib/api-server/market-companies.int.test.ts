import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@aptamind/contracts';
import {
  COMPANY_SUMMARY_FACTS,
  factsHash,
  CURSOR_MAX,
  decodeCursor,
  SUMMARY_ROW_MAX,
  type CompanyDoc,
  companyDocSchema,
  companyDetailResponseDto,
  companyListFullResponseDto,
  companyListQuerySchema,
  companyListSummaryResponseDto,
  companySummaryDto,
  emptyCompany,
  explainCompanyList,
  type JobDoc,
  planStages,
  strictNameKey,
} from '@aptamind/market';
import {
  type ApiHarness,
  expectDto,
  expectValidationError,
  mongoOrder,
  startApiHarness,
  traverse,
} from './market-test-harness';

/**
 * Companies list v2 (M7.2) over ~1.2k companies: whitelisted sorts with keyset pagination
 * (stable under concurrent inserts), the filter matrix, anchored search, the summary view,
 * 400s and index use.
 */

let h: ApiHarness;
let acmeId: string;
let all: CompanyDoc[];
const T0 = Date.parse('2026-01-01T00:00:00Z');
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'nova', 'terra', 'lumen', 'vector', 'zephyr'];
const CAREERS = ['not_attempted', 'found', 'not_found', 'failed', 'website_unknown'] as const;

const known = <T>(value: T) => ({
  value,
  status: 'known' as const,
  confidence: { level: 'high' as const, reasons: ['test'] },
  evidence: [],
  conflicts: [],
});

function synthetic(i: number): CompanyDoc {
  const name = `${WORDS[i % 10]} ${WORDS[Math.floor(i / 10) % 10]} holdings ${i} ltd`;
  // Ties on createdAt and lastChangedAt (and missing lastChangedAt) exercise the `_id` tiebreak.
  const c = emptyCompany(
    newId('cmp'),
    name,
    [`name:${strictNameKey(name)}`],
    new Date(T0 + (i % 400) * 1000),
  );
  if (i % 3 === 0) c.identity.domain = known(`${WORDS[i % 10]}${i}.com`);
  if (i % 7 === 0)
    c.identity.aliases = [{ name: `Zed Trading ${i}`, strictKey: `zed trading ${i}`, sourceIds: [] }];
  c.freshness.careersDiscoveryStatus = CAREERS[i % 5]!;
  if (i % 4 === 1) c.employment.sponsorship.capability = known('licensed');
  if (i % 4 === 2) c.employment.sponsorship.capability = known('previously_licensed');
  c.employment.sponsorship.licenceCountries = i % 4 === 1 ? ['GB'] : [];
  if (i % 11 === 0) c.quality.conflictFields = ['identity.domain'];
  c.quality.sourceIds = [`src_syn${i % 6}`];
  if (i % 5 !== 0) c.freshness.lastChangedAt = new Date(T0 + (i % 50) * 60_000);
  return c;
}

beforeAll(async () => {
  h = await startApiHarness('companies');
  await h.seedSponsorRegister();
  acmeId = (await h.market.companies.col.findOne({ 'identity.normalizedName': 'acme ltd' }))!._id;
  await h.seedGreenhouseBoard(acmeId);

  const docs = Array.from({ length: 1200 }, (_, i) => companyDocSchema.parse(synthetic(i)));
  await h.market.companies.col.insertMany(docs);
  // Jobs for every 9th synthetic company (cloned from a real job); every 18th one's job is CLOSED.
  const template = (await h.market.jobs.col.findOne({ companyId: acmeId }))!;
  const jobs: JobDoc[] = docs
    .filter((_, i) => i % 9 === 0)
    .map((c, k) => {
      const id = newId('job');
      return {
        ...structuredClone(template),
        _id: id,
        companyId: c._id,
        sourceKeys: [`src_clone:${id}`],
        lifecycle: { ...template.lifecycle, state: k % 2 ? 'CLOSED' : 'VERIFIED_LIVE' },
      };
    });
  await h.market.jobs.col.insertMany(jobs);
  // Open reviews: as entity for every 13th, as candidate for every 17th (a resolved one never counts).
  for (const [i, c] of docs.entries()) {
    if (i % 13 === 0)
      await h.market.reviews.raise({
        type: 'company_duplicate',
        severity: 'low',
        dedupeKey: `t:entity:${c._id}`,
        entity: { kind: 'company', id: c._id },
        subject: 's',
        reason: 'r',
        allowedActions: ['dismiss'],
      });
    if (i % 17 === 0)
      await h.market.reviews.raise({
        type: 'company_resolution',
        severity: 'low',
        dedupeKey: `t:candidate:${c._id}`,
        entity: { kind: 'observation', id: `cobs_${i}` },
        candidates: [{ kind: 'company', id: c._id, label: 'x' }],
        subject: 's',
        reason: 'r',
        allowedActions: ['dismiss'],
      });
  }
  const resolvedOnly = docs[1]!;
  const { item } = await h.market.reviews.raise({
    type: 'company_duplicate',
    severity: 'low',
    dedupeKey: `t:resolved:${resolvedOnly._id}`,
    entity: { kind: 'company', id: resolvedOnly._id },
    subject: 's',
    reason: 'r',
    allowedActions: ['dismiss'],
  });
  await h.market.reviews.col.updateOne({ _id: item._id }, { $set: { status: 'dismissed' } });
  all = await h.market.companies.col.find({ status: 'active' }).toArray();
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const idsOf = (rows: Array<{ _id: string }>) => rows.map((r) => r._id);

async function openReviewIds(): Promise<Set<string>> {
  const open = await h.market.reviews.col.find({ status: 'open' }).toArray();
  return new Set(open.flatMap((r) => [r.entity.id, ...r.candidates.map((c) => c.id)]));
}

async function activeJobCompanyIds(): Promise<Set<string>> {
  const jobs = await h.market.jobs.col
    .find({ status: 'active', 'lifecycle.state': { $ne: 'CLOSED' } })
    .toArray();
  return new Set(jobs.map((j) => j.companyId));
}

describe('GET /api/companies v2: sort + keyset pagination', () => {
  const cases: Array<[string, (c: CompanyDoc) => string | Date | null | undefined, 1 | -1]> = [
    ['name', (c) => c.identity.normalizedName, 1],
    ['-name', (c) => c.identity.normalizedName, -1],
    ['createdAt', (c) => c.createdAt, 1],
    ['-createdAt', (c) => c.createdAt, -1],
    ['lastChangedAt', (c) => c.freshness.lastChangedAt, 1],
    ['-lastChangedAt', (c) => c.freshness.lastChangedAt, -1],
  ];
  it.each(cases)('sort=%s walks every company once, in order', async (sort, value, dir) => {
    const { rows, pages } = await traverse<{ _id: string }>(
      h,
      `/api/companies?sort=${sort}&limit=97&view=summary&count=none`,
    );
    expect(pages).toBe(Math.ceil(all.length / 97));
    expect(idsOf(rows)).toEqual(mongoOrder(all, value, dir));
  });

  it('is stable under concurrent inserts: no duplicates, no skipped pre-existing rows', async () => {
    const before = new Set(all.map((c) => c._id));
    let n = 0;
    const inserted: string[] = [];
    const { rows } = await traverse<{ _id: string }>(h, '/api/companies?sort=name&limit=61&count=none', {
      between: async () => {
        // Names both before and after the cursor position (a… sorts first, z… last).
        const docs = ['aaa', 'mmm', 'zzz'].map((p) => {
          const name = `${p} concurrent ${n++}`;
          return companyDocSchema.parse(
            emptyCompany(newId('cmp'), name, [`name:${strictNameKey(name)}`], new Date()),
          );
        });
        inserted.push(...docs.map((d) => d._id));
        await h.market.companies.col.insertMany(docs);
      },
    });
    const ids = idsOf(rows);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of before) expect(ids).toContain(id);
    // Rows inserted after the cursor passed their position are the only ones that may be missing.
    expect(ids.filter((id) => !before.has(id)).every((id) => inserted.includes(id))).toBe(true);
    await h.market.companies.col.deleteMany({ _id: { $in: inserted } });
  });

  it('v1 offset paging still works (same order, numeric total, v1 page fields)', async () => {
    const p1 = expectDto(companyListFullResponseDto, (await h.get('/api/companies?limit=50&offset=50')).body);
    expect(p1.total).toBe(all.length);
    expect(p1.offset).toBe(50);
    expect(idsOf(p1.items as Array<{ _id: string }>)).toEqual(
      mongoOrder(all, (c) => c.identity.normalizedName, 1).slice(50, 100),
    );
  });

  it('count=exact (default) returns the filtered total; count=none returns null', async () => {
    const exact = expectDto(companyListSummaryResponseDto, (await h.get('/api/companies?view=summary')).body);
    expect(exact.total).toBe(all.length);
    expect(exact.nextCursor).toEqual(expect.any(String));
    const none = expectDto(
      companyListSummaryResponseDto,
      (await h.get('/api/companies?view=summary&count=none')).body,
    );
    expect(none.total).toBeNull();
  });
});

describe('GET /api/companies v2: filters and search', () => {
  const check = async (query: string, predicate: (c: CompanyDoc) => boolean) => {
    const expected = all.filter(predicate).map((c) => c._id);
    const { rows, first } = await traverse<{ _id: string }>(
      h,
      `/api/companies?${query}&view=summary&limit=200`,
    );
    expect(new Set(idsOf(rows))).toEqual(new Set(expected));
    expect(first.total).toBe(expected.length);
    return expected.length;
  };

  it('hasDomain, careersStatus[], licenceStatus[], sponsorCountry, hasConflicts, sourceId[]', async () => {
    expect(await check('hasDomain=true', (c) => c.identity.domain.value !== null)).toBeGreaterThan(300);
    expect(await check('hasDomain=false', (c) => c.identity.domain.value === null)).toBeGreaterThan(500);
    await check(
      'careersStatus=found,failed',
      (c) =>
        c.freshness.careersDiscoveryStatus === 'found' || c.freshness.careersDiscoveryStatus === 'failed',
    );
    await check('careersStatus=found&careersStatus=failed', (c) =>
      ['found', 'failed'].includes(c.freshness.careersDiscoveryStatus),
    );
    await check('licenceStatus=previously_licensed,none', (c) =>
      [null, 'previously_licensed'].includes(c.employment.sponsorship.capability.value),
    );
    await check('sponsorCountry=gb', (c) => c.employment.sponsorship.licenceCountries.includes('GB'));
    await check('hasConflicts=true', (c) => c.quality.conflictFields.length > 0);
    await check('hasConflicts=false', (c) => c.quality.conflictFields.length === 0);
    await check('sourceId=src_syn1,src_syn2', (c) =>
      c.quality.sourceIds.some((s) => ['src_syn1', 'src_syn2'].includes(s)),
    );
  });

  it('changedAfter/Before and createdAfter/Before are date ranges', async () => {
    const a = new Date(T0 + 10 * 60_000);
    const b = new Date(T0 + 20 * 60_000);
    await check(
      `changedAfter=${a.toISOString()}&changedBefore=${b.toISOString()}`,
      (c) => !!c.freshness.lastChangedAt && c.freshness.lastChangedAt >= a && c.freshness.lastChangedAt < b,
    );
    await check('createdBefore=2026-01-01T00:01:00Z', (c) => c.createdAt < new Date(T0 + 60_000));
  });

  it('hasActiveJobs and hasOpenReviews are live semi-joins', async () => {
    const active = await activeJobCompanyIds();
    expect(await check('hasActiveJobs=true&count=exact', (c) => active.has(c._id))).toBeGreaterThan(60);
    await check(
      'hasActiveJobs=false&hasDomain=true&count=exact',
      (c) => !active.has(c._id) && !!c.identity.domain.value,
    );
    const open = await openReviewIds();
    expect(await check('hasOpenReviews=true&count=exact', (c) => open.has(c._id))).toBeGreaterThan(100);
    await check(
      'hasOpenReviews=false&careersStatus=found&count=exact',
      (c) => !open.has(c._id) && c.freshness.careersDiscoveryStatus === 'found',
    );
    // With a live semi-join the total is skipped unless asked for.
    expect(((await h.get('/api/companies?hasActiveJobs=true')).body as { total: unknown }).total).toBeNull();
    // Paging through a semi-join keeps the order and loses nothing.
    const { rows } = await traverse<{ _id: string }>(
      h,
      '/api/companies?hasActiveJobs=true&sort=-createdAt&limit=7&count=none',
    );
    expect(idsOf(rows)).toEqual(
      mongoOrder(
        all.filter((c) => active.has(c._id)),
        (c) => c.createdAt,
        -1,
      ),
    );
  });

  it('q: anchored prefix over name, alias and domain', async () => {
    await check('q=Alpha Beta', (c) => c.identity.normalizedName.startsWith('alpha beta'));
    await check('q=zed trading 7', (c) =>
      c.identity.aliases.some((a) => a.strictKey.startsWith('zed trading 7')),
    );
    await check('q=gamma12', (c) => (c.identity.domain.value ?? '').startsWith('gamma12'));
    await check('q=https://www.gamma12.com/careers', (c) => c.identity.domain.value === 'gamma12.com');
    // No substring matching: "holdings" is inside every synthetic name but never at the start.
    await check('q=holdings', () => false);
  });
});

describe('GET /api/companies v2: summary view', () => {
  it('rows are strict summaries (no evidence) within the row budget, with live active-job counts', async () => {
    const page = expectDto(
      companyListSummaryResponseDto,
      (await h.get('/api/companies?view=summary&limit=200&hasActiveJobs=true')).body,
    );
    for (const row of page.items) {
      expect(JSON.stringify(row).length).toBeLessThanOrEqual(SUMMARY_ROW_MAX);
      expect(JSON.stringify(row)).not.toContain('"evidence"');
      expect(row.activeJobCount).toBeGreaterThan(0);
    }
    const acme = expectDto(companySummaryDto, (await h.get(`/api/companies/${acmeId}?view=summary`)).body);
    expect(acme.activeJobCount).toBe(5);
    expect(acme.identity.displayName.value).toBe('Acme Ltd');
    const acmeDoc = (await h.market.companies.col.findOne({ _id: acmeId }))!;
    const capability = acmeDoc.employment.sponsorship.capability;
    expect(acme.employment.sponsorship.capability).toEqual({
      value: 'licensed',
      status: 'known',
      confidence: { level: 'high' },
      basis: capability.confidence.reasons[0] ?? null,
      alternates: capability.conflicts.length,
    });
    expect(acme.employment.sponsorship.capability.basis).toEqual(expect.any(String));
    expect(acme.rev).toBe(acmeDoc.rev ?? 0);
    expect(acme.contentHash).toBe(acmeDoc.reconciliation?.contentHash ?? null);
    expect(acme.contentHash).toEqual(expect.any(String));
    expect(acme.factsHash).toBe(factsHash(acmeDoc, COMPANY_SUMMARY_FACTS));
    // A company never reconciled has no contentHash, but its facts are still pinned.
    const fresh = emptyCompany(newId('cmp'), 'Unreconciled Co', ['name:unreconciled co'], new Date());
    await h.market.companies.col.insertOne(companyDocSchema.parse(fresh));
    const unrec = expectDto(
      companySummaryDto,
      (await h.get(`/api/companies/${fresh._id}?view=summary`)).body,
    );
    expect(unrec.contentHash).toBeNull();
    expect(unrec.factsHash).toBe(factsHash(fresh, COMPANY_SUMMARY_FACTS));
    await h.market.companies.col.deleteOne({ _id: fresh._id });

    // openReviewCount is live (entity or candidate), unlike the stored `quality.openReviewCount`.
    const before = acme.openReviewCount;
    const other = (await h.market.companies.col.findOne({ status: 'active', _id: { $ne: acmeId } }))!;
    const raised = await Promise.all([
      h.market.reviews.raise({
        type: 'field_conflict',
        severity: 'low',
        dedupeKey: `t:summary:${acmeId}`,
        entity: { kind: 'company', id: acmeId },
        subject: 's',
        reason: 'r',
        allowedActions: ['dismiss'],
      }),
      h.market.reviews.raise({
        type: 'company_duplicate',
        severity: 'low',
        dedupeKey: `t:summary:dup:${other._id}`,
        entity: { kind: 'company', id: other._id },
        candidates: [{ kind: 'company', id: acmeId, label: 'Acme' }],
        subject: 's',
        reason: 'r',
        allowedActions: ['dismiss'],
      }),
    ]);
    const live = async () =>
      expectDto(companySummaryDto, (await h.get(`/api/companies/${acmeId}?view=summary`)).body)
        .openReviewCount;
    expect(await live()).toBe(before + 2);
    for (const r of raised)
      await h.market.reviews.col.updateOne({ _id: r.item._id }, { $set: { status: 'dismissed' } });
    expect(await live()).toBe(before);
    // The detail summary is exactly the list row.
    const row = (await h.get(`/api/companies?view=summary&q=acme ltd`)).body as { items: unknown[] };
    expect(row.items).toContainEqual(acme);
    // The full detail is unchanged by default.
    expectDto(companyDetailResponseDto, (await h.get(`/api/companies/${acmeId}`)).body);
  });
});

describe('GET /api/companies v2: validation and index use', () => {
  it.each([
    ['unknown sort', '/api/companies?sort=displayName'],
    ['unknown view', '/api/companies?view=compact'],
    ['after with offset', '/api/companies?after=abc&offset=10'],
    ['malformed cursor', '/api/companies?after=not-a-cursor'],
    ['bad licence status', '/api/companies?licenceStatus=yes'],
    ['bad careers status in a list', '/api/companies?careersStatus=found,foundd'],
    ['bad date', '/api/companies?changedAfter=yesterday'],
    ['bad count', '/api/companies?count=approx'],
    ['empty search', '/api/companies?q='],
    ['unknown detail view', `/api/companies/cmp_x?view=compact`],
  ])('400: %s', async (_name, url) => {
    expectValidationError(await h.get(url));
  });

  it('400 when a cursor is replayed with another sort', async () => {
    const page = (await h.get('/api/companies?sort=name&limit=5')).body as { nextCursor: string };
    expectValidationError(await h.get(`/api/companies?sort=-createdAt&after=${page.nextCursor}`));
  });

  it('pages are served from indexes (no collection scan; no blocking sort for plain sorts)', async () => {
    const db = h.market.ctx.db;
    const q = (query: Record<string, string | undefined>) => companyListQuerySchema.parse(query);
    const first = (await h.get('/api/companies?sort=-lastChangedAt&limit=20')).body as { nextCursor: string };
    for (const query of [
      {},
      { sort: '-createdAt' },
      { sort: 'lastChangedAt', view: 'summary' },
      { sort: '-lastChangedAt', after: first.nextCursor },
    ]) {
      const stages = planStages(await explainCompanyList(db, q(query)));
      expect(stages).toContain('IXSCAN');
      expect(stages).not.toContain('COLLSCAN');
      expect(stages).not.toContain('SORT');
    }
    for (const query of [
      { q: 'alpha' },
      { q: 'gamma12.com' },
      { careersStatus: 'found', hasDomain: 'true' },
    ]) {
      const stages = planStages(await explainCompanyList(db, q(query)));
      expect(stages).toContain('IXSCAN');
      expect(stages).not.toContain('COLLSCAN');
    }
  });
});

describe('GET /api/companies v2: cursors for very long sort values', () => {
  it('a cursor we issued is always accepted: long names get a short reference cursor', async () => {
    const long = (i: number) => `Zzlong ${String(i)} ${'x'.repeat(3000)} ltd`;
    const docs = [2, 0, 1].map((i) =>
      companyDocSchema.parse(
        emptyCompany(newId('cmp'), long(i), [`name:${strictNameKey(long(i))}`], new Date()),
      ),
    );
    await h.market.companies.col.insertMany(docs);
    const byName = [...docs].sort((a, b) => (a.identity.normalizedName < b.identity.normalizedName ? -1 : 1));
    for (const [sort, expected] of [
      ['name', byName],
      ['-name', [...byName].reverse()],
    ] as const) {
      const first = (await h.get(`/api/companies?q=zzlong&sort=${sort}&limit=1&count=none`)).body as {
        nextCursor: string;
      };
      expect(first.nextCursor.length).toBeLessThanOrEqual(CURSOR_MAX);
      expect(decodeCursor(first.nextCursor, sort, 1)).toEqual({ ref: true, id: expected[0]!._id });
      const { rows } = await traverse<{ _id: string }>(
        h,
        `/api/companies?q=zzlong&sort=${sort}&limit=1&count=none`,
      );
      expect(idsOf(rows)).toEqual(expected.map((d) => d._id));
    }
    // Short values keep a self-contained cursor.
    const short = (await h.get('/api/companies?sort=name&limit=1')).body as { nextCursor: string };
    expect(decodeCursor(short.nextCursor, 'name', 1)).not.toHaveProperty('ref');
    // A reference to a row that no longer exists is a 400, not a 500.
    const ref = (await h.get('/api/companies?q=zzlong&sort=name&limit=1')).body as { nextCursor: string };
    await h.market.companies.col.deleteOne({ _id: byName[0]!._id });
    expectValidationError(await h.get(`/api/companies?q=zzlong&sort=name&after=${ref.nextCursor}`));
    await h.market.companies.col.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
  });
});
