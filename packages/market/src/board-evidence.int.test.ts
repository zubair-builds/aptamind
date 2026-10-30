/**
 * Board-derived verification is the same evidence as a listing read (DECISION_LOG b7f1a76): an
 * Ashby `not_found` only corroborates a JOB-LEVEL absence run — ≥ 2 consecutive applied absences
 * counted at the job level, no positive evidence since the first of them, no hold; an empty board
 * also needs no positive evidence on the source since then — and a small-board hold is re-armed
 * by positive evidence. Every scenario runs end to end through `finalize_job_listing` (listing
 * runs) and the verification service; none of them may close a live job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra } from '@aptamind/testing';
import type { JobDoc } from './jobs/job.schema';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let companyId: string;
const boards = new Map<string, unknown>();
/** Careers-site posting pages on the fixture server, by path (no test reaches a real host). */
const pages = new Map<string, string>();

/** Distinct roles per id, so the resolver never merges two board entries into one job. */
const ROLES: Record<string, [string, string]> = {
  a1: ['Backend Engineer', 'Design and run payment APIs in Go and PostgreSQL.'],
  a2: ['Product Designer', 'Shape onboarding flows with research and prototypes in Figma.'],
  a3: ['Data Analyst', 'Model churn and revenue with SQL, dbt and Looker dashboards.'],
  a4: ['Account Executive', 'Close mid-market deals and manage a quota across the Nordics.'],
  b1: ['Site Reliability Engineer', 'Operate Kubernetes clusters and own incident response rotations.'],
};
const job = (token: string, id: string) => ({
  id,
  title: ROLES[id]![0],
  location: 'Remote',
  isListed: true,
  jobUrl: `https://jobs.ashbyhq.com/${token}/${id}`,
  descriptionPlain: `${ROLES[id]![1]} Board ${token}.`,
});

beforeAll(async () => {
  infra = await createTestInfra('board_evidence');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    const page = pages.get((req.url ?? '').split('?')[0] ?? '');
    if (page !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html' }).end(page);
      return;
    }
    const body = boards.get((req.url ?? '').split('?')[0] ?? '');
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:board-evidence',
        name: 'Directory',
        category: 'company_universe',
        provider: 'fixture',
        acquisition: { workflowKey: 'market.noop' },
        freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
        authority: { tier: 'official_site' },
      },
      t.actor,
    )
  ).source;
  const company = await t.market.companyPipeline.process({
    sourceId: directory._id,
    externalId: 'gamma-evidence',
    payload: { name: 'Gamma Evidence Ltd', aliases: [], externalIds: [], locations: [], industries: [] },
    parser: { name: 'test', version: '1' },
  });
  if (company.outcome !== 'created' && company.outcome !== 'matched') throw new Error('company not created');
  companyId = company.companyId;
});

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

/** An Ashby board source; `set(jobs)` changes what its listing and its board reads return. */
async function ashbyBoard(token: string) {
  const path = `/posting-api/job-board/${token}`;
  const source = (
    await t.market.sources.register(
      {
        key: `ashby:${token}`,
        name: `${token} (ashby)`,
        category: 'job_source',
        provider: 'ashby',
        endpoint: { boardToken: token, url: `${server.url}${path}` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
  const set = (jobs: unknown[]) => boards.set(path, { jobs });
  const listing = async () => expect((await t.runSource(source._id)).state).toBe('COMPLETED');
  const of = async (id: string) =>
    (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:${id}` })) as JobDoc;
  let n = 0;
  const read = async (id: string) =>
    t.market.verification.verify((await of(id))._id, t.runtime.http, {
      operationKey: `${token}-read-${++n}`,
    });
  const held = async () => (await t.market.sources.get(source._id)).health.listingHeld;
  const all = (ids: string[]) => ids.map((id) => job(token, id));
  return { source, set, listing, of, read, held, all };
}

/** An entry that makes an Ashby listing incomplete (malformed, no id): the listing is not applied. */
const idless = { title: 'broken entry without an id' };

describe('DECISION_LOG b7f1a76: board-derived not_found only corroborates a job-level absence run', () => {
  it('guard "job-level absences ≥ 2": a dead small board closes only after hold → apply → apply → read', async () => {
    const b = await ashbyBoard('dead-small');
    b.set(b.all(['a1', 'a2', 'a3']));
    await b.listing();
    b.set([]);
    await b.listing(); // held one run (L2)
    expect(await b.held()).toMatchObject({ reason: 'small_board_empty' });
    await b.listing(); // applied: absence 1
    expect((await b.of('a1')).lifecycle.consecutiveAbsences).toBe(1);
    expect(await b.read('a1')).toMatchObject({ outcome: 'inconclusive' }); // one absence is not a run
    await b.listing(); // applied: absence 2
    expect(await b.read('a1')).toMatchObject({ outcome: 'not_found' });
    expect((await b.of('a1')).lifecycle.state).toBe('CLOSED');
  });

  it('V1: a held listing that shows the job re-arms the hold; the empty reads after it do not close', async () => {
    const b = await ashbyBoard('v1');
    b.set(b.all(['a1', 'a2', 'a3']));
    await b.listing();
    b.set([]);
    await b.listing(); // held
    b.set([job('v1', 'a1'), idless]); // incomplete (not applied), but a1 is seen
    await b.listing();
    b.set([]);
    await b.listing(); // re-armed: held again, not applied
    expect(await b.held()).toMatchObject({ reason: 'small_board_empty' });
    expect(await b.read('a1')).toMatchObject({ outcome: 'inconclusive' });
    expect(await b.read('a1')).toMatchObject({ outcome: 'inconclusive' });
    expect((await b.of('a1')).lifecycle.state).not.toBe('CLOSED');
  });

  it('V1b / guard "hold re-arm": a live read after the hold re-arms it, so two empty listings are one absence', async () => {
    const b = await ashbyBoard('v1b');
    b.set(b.all(['a1', 'a2', 'a3']));
    await b.listing();
    b.set([]);
    await b.listing(); // held
    b.set(b.all(['a1', 'a2', 'a3']));
    expect(await b.read('a1')).toMatchObject({ outcome: 'live' });
    b.set([]);
    await b.listing(); // re-armed by the live read: held again
    expect(await b.read('a1')).toMatchObject({ outcome: 'inconclusive' });
    await b.listing(); // applied: absence 1 only
    expect((await b.of('a1')).lifecycle.consecutiveAbsences).toBe(1);
    expect(await b.read('a1')).toMatchObject({ outcome: 'inconclusive' });
    expect((await b.of('a1')).lifecycle.state).not.toBe('CLOSED');
  });

  it('MC / guard "no other copy": an Ashby copy that died while an official-site copy is present never closes the job', async () => {
    const b = await ashbyBoard('mc');
    b.set(b.all(['a1', 'a2', 'a3']));
    await b.listing();
    pages.set('/careers/mc/backend-engineer', '<html><body><h1>Backend Engineer</h1></body></html>');
    const site = (
      await t.market.sources.register(
        {
          key: 'careers:mc-site',
          name: 'MC careers site',
          category: 'job_source',
          provider: 'careers_page',
          acquisition: { workflowKey: 'market.careers_page.crawl' },
          companyId,
          freshness: { policyClass: 'source.careers_page', maxAgeMinutes: 2160 },
          authority: { tier: 'official_site', listingIsComplete: false },
          governance: { accessMethod: 'public_web' },
        },
        t.actor,
      )
    ).source as SourceDoc;
    await t.market.jobPipeline.process({
      source: site,
      locator: 'https://mc.example/careers/a1',
      payload: {
        externalId: 'site-a1',
        title: 'Backend Engineer',
        descriptionText: 'Design and run payment APIs in Go and PostgreSQL. Board mc.',
        locations: [{ text: 'Remote' }],
        postingUrl: `${server.url}/careers/mc/backend-engineer`,
        provider: { name: 'careers_page' },
      },
      parser: { name: 'test', version: '1' },
    });
    expect((await b.of('a1')).sourceRefs.map((r) => r.authority).sort()).toEqual([
      'official_ats',
      'official_site',
    ]);
    b.set([]);
    await b.listing(); // held
    await b.listing(); // applied: the Ashby copy is absent, the job is not (the site copy is present)
    await b.listing(); // applied again
    const a1 = await b.of('a1');
    expect(a1.sourceRefs.find((r) => r.authority === 'official_ats')?.present).toBe(false);
    expect(a1.lifecycle.consecutiveAbsences).toBe(0);
    // The job is verified on its present official-site copy (a fixture page), which is live.
    expect(await b.read('a1')).toMatchObject({ outcome: 'live', method: 'posting_url', sourceId: site._id });
    expect((await b.of('a1')).lifecycle.state).not.toBe('CLOSED');
  });

  it('M2 / guard "source evidence": after a dead board closed a1, a held listing shows b1 — an empty read of a1 is inconclusive', async () => {
    const b = await ashbyBoard('m2');
    b.set(b.all(['a1', 'b1']));
    await b.listing();
    b.set([]);
    await b.listing(); // held
    await b.listing(); // absence 1
    await b.listing(); // absence 2
    expect(await b.read('a1')).toMatchObject({ outcome: 'not_found' });
    expect((await b.of('a1')).lifecycle.state).toBe('CLOSED');
    b.set([job('m2', 'b1'), idless]); // incomplete: not applied, but b1 is on the board
    await b.listing();
    b.set([]);
    expect(await b.read('a1')).toMatchObject({ outcome: 'inconclusive' });
  });

  it('guard "no positive evidence since the first absence": a held-listing sighting of the job (a skipped entry) blocks the read', async () => {
    const b = await ashbyBoard('sighting');
    b.set(b.all(['a1', 'a2', 'a3', 'a4']));
    await b.listing();
    b.set(b.all(['a2', 'a3', 'a4']));
    await b.listing(); // absence 1 (an ordinary drop, applied)
    await b.listing(); // absence 2
    expect((await b.of('a1')).lifecycle.consecutiveAbsences).toBe(2);
    // a1 comes back malformed (skipped; 1 of 4 > 10 %, so the listing is incomplete and not
    // applied): it is on the board — a positive that ends the absence run (derived, 6a01b36),
    // though not a verification (U1: lastVerifiedAt does not move).
    const run = (await b.of('a1')).lifecycle;
    b.set([{ id: 'a1', title: '' }, ...b.all(['a2', 'a3', 'a4'])]);
    await b.listing();
    const a1 = await b.of('a1');
    expect(a1.lifecycle.consecutiveAbsences).toBe(0);
    expect(a1.lifecycle.lastVerifiedAt?.getTime()).toBe(run.lastVerifiedAt?.getTime());
    expect(a1.lifecycle.lastSeenAt.getTime()).toBeGreaterThan(run.absentSince!.getTime());
    b.set(b.all(['a2', 'a3', 'a4']));
    expect(await b.read('a1')).toMatchObject({ outcome: 'inconclusive' });
  });
});
