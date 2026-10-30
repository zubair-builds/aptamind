import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@aptamind/contracts';
import { type CompanyDoc, emptyCompany, type JobDoc, strictNameKey } from '@aptamind/market';
import { type ApiHarness, startApiHarness } from './market-test-harness';

/**
 * Performance regression (PR #10 review H2): "has active jobs" / "has open reviews" on a ~30k
 * company universe where few companies qualify. The filters are driven from the small side (ids
 * of qualifying companies), so a page never visits the whole universe.
 */

const N = 30_000;
let h: ApiHarness;
let withJobs: string[];
let withReviews: string[];

beforeAll(async () => {
  h = await startApiHarness('perf');
  const now = new Date();
  for (let b = 0; b < N; b += 2000) {
    const docs: CompanyDoc[] = [];
    for (let i = b; i < Math.min(N, b + 2000); i++) {
      const name = `perf company ${String(i).padStart(6, '0')} ltd`;
      docs.push(emptyCompany(newId('cmp'), name, [`name:${strictNameKey(name)}`], now));
    }
    await h.market.companies.col.insertMany(docs);
  }
  const ids = (await h.market.companies.col.find({}, { projection: { _id: 1 } }).toArray()).map((c) => c._id);
  // One real board for a job template, then 40 companies spread over the universe get a job.
  await h.seedGreenhouseBoard(ids[0]!);
  const template = (await h.market.jobs.col.findOne({ companyId: ids[0] }))!;
  withJobs = [ids[0]!, ...Array.from({ length: 40 }, (_, k) => ids[Math.floor(((k + 1) * N) / 42)]!)];
  await h.market.jobs.col.insertMany(
    withJobs.slice(1).map((companyId): JobDoc => {
      const id = newId('job');
      return { ...structuredClone(template), _id: id, companyId, sourceKeys: [`src_perf:${id}`] };
    }),
  );
  withReviews = Array.from({ length: 30 }, (_, k) => ids[Math.floor(((k + 1) * N) / 31) + 7]!);
  for (const id of withReviews)
    await h.market.reviews.raise({
      type: 'company_duplicate',
      severity: 'low',
      dedupeKey: `perf:${id}`,
      entity: { kind: 'company', id },
      subject: 's',
      reason: 'r',
      allowedActions: ['dismiss'],
    });
}, 300_000);

afterAll(async () => {
  await h?.close();
});

const timed = async (url: string) => {
  const t = Date.now();
  const res = await h.get(url);
  expect(res.status).toBe(200);
  return { ms: Date.now() - t, body: res.body as { items: Array<{ _id: string }>; total: number | null } };
};

describe(`semi-join filters on ${N} companies`, () => {
  it('hasActiveJobs=true returns the few hiring companies quickly', async () => {
    const { ms, body } = await timed('/api/companies?hasActiveJobs=true&view=summary&limit=200');
    expect(new Set(body.items.map((c) => c._id))).toEqual(new Set(withJobs));
    expect(body.total).toBeNull(); // count defaults to none with a semi-join
    expect(ms).toBeLessThan(1500);
  });

  it('hasOpenReviews=true and the negated filters page quickly', async () => {
    const open = await timed('/api/companies?hasOpenReviews=true&view=summary&limit=200&count=exact');
    expect(new Set(open.body.items.map((c) => c._id))).toEqual(new Set(withReviews));
    expect(open.body.total).toBe(30);
    expect(open.ms).toBeLessThan(1500);
    const none = await timed(
      '/api/companies?hasActiveJobs=false&hasOpenReviews=false&view=summary&limit=100',
    );
    expect(none.body.items).toHaveLength(100);
    expect(none.ms).toBeLessThan(1500);
  });
});
