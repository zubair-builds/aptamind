/**
 * OPS-1b: a live ATS board is company identity evidence. A board file row resolves in order
 * (board source, domain, `ats` id, unique exact name, review); with no match one liveness fetch
 * decides. Real MongoDB/Redis/S3; the provider APIs are a loopback stub server.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SafeHttpClient, SafeRequest } from '@aptamind/net';
import { deterministicId } from '@aptamind/contracts';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import { NET_CLIENT } from '@aptamind/workflow-nodes';
import { atsExternalId } from './companies/external-ids';
import { strictNameKey } from './companies/normalize';
import type { ImportReport } from './imports/import-report';
import { atsBoardIdentity, registerAtsBoard } from './sources/board-registration';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Server;
let port = 0;
/** Board tokens the stub was asked for, in order. */
const fetched: string[] = [];
/** Host scopes the liveness requests carried. */
const scopes: unknown[] = [];
/** Work the stub does before it answers for a token (a race, a barrier). */
const beforeReply = new Map<string, () => Promise<void>>();

const API_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards-api.eu.greenhouse.io',
  'api.lever.co',
  'api.eu.lever.co',
  'api.ashbyhq.com',
]);

/**
 * The stub answers by token: `dead*` 404, `down*` 503, `junk*` JSON that is not a listing,
 * `html*` a 200 HTML page, `hop*` a redirect off the API host, anything else an empty listing in
 * the provider's shape.
 */
function startStub(): Promise<number> {
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const [, host, ...rest] = url.pathname.split('/');
      const token = decodeURIComponent(
        host === 'boards-api.greenhouse.io' || host === 'boards-api.eu.greenhouse.io'
          ? rest[2]!
          : rest.at(-1)!,
      );
      fetched.push(token);
      await beforeReply.get(token)?.();
      reply(token, host, res);
    })();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

function reply(token: string, host: string | undefined, res: ServerResponse): void {
  if (token.startsWith('dead')) return void res.writeHead(404).end('not found');
  if (token.startsWith('down')) return void res.writeHead(503).end('unavailable');
  if (token.startsWith('html'))
    return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html>busy</html>');
  if (token.startsWith('hop'))
    return void res.writeHead(302, { location: `http://localhost:${port}/elsewhere` }).end();
  res.writeHead(200, { 'content-type': 'application/json' });
  if (token.startsWith('junk')) return void res.end('{"error":"no board"}');
  res.end(host?.includes('lever') ? '[]' : '{"jobs":[]}');
}

/** The runtime client with provider API hosts sent to the stub (path and query kept). */
function stubbedHttp(real: SafeHttpClient, port: number): SafeHttpClient {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== 'request') return Reflect.get(target, prop, receiver) as unknown;
      return (req: SafeRequest) => {
        const u = new URL(req.url);
        if (!API_HOSTS.has(u.hostname)) throw new Error(`unexpected request to ${u.hostname}`);
        scopes.push(req.scope);
        return target.request({
          ...req,
          url: `http://127.0.0.1:${port}/${u.hostname}${u.pathname}${u.search}`,
          // The provider hosts become the stub: every hop must still stay on it.
          ...(req.scope ? { scope: { allowedHosts: ['127.0.0.1'], allowSubdomains: false } } : {}),
        });
      };
    },
  });
}

beforeAll(async () => {
  infra = await createTestInfra('board_identity');
  t = await createMarketTestRuntime(infra);
  port = await startStub();
  t.runtime.services.register(NET_CLIENT, stubbedHttp(t.runtime.http, port));
});

afterAll(async () => {
  await t?.stop();
  await infra?.cleanup();
  await new Promise((r) => server?.close(r));
});

async function boardSource(key: string): Promise<SourceDoc> {
  return (
    await t.market.sources.register(
      {
        key: `boards:${key}`,
        name: `${key} boards`,
        category: 'manual_import',
        provider: 'ats_board_directory',
        acquisition: {
          workflowKey: 'market.ats_boards.import',
          config: {
            columns: {
              provider: 'Provider',
              token: 'Token',
              company: 'Company',
              domain: 'Domain',
              url: 'Link',
            },
          },
        },
        freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
        governance: { accessMethod: 'manual_upload' },
      },
      t.actor,
    )
  ).source;
}

async function importFile(source: SourceDoc, csv: string) {
  const upload = await t.upload(source._id, csv, 'text/csv');
  const run = await t.runSource(source._id, { snapshotId: upload.snapshotId });
  expect(run.state).toBe('COMPLETED');
  const output = run.output as { importReport: ImportReport; outcomes: Record<string, number> };
  return { report: output.importReport, outcomes: output.outcomes };
}

async function company(
  name: string,
  domain: string | null,
  externalIds: Array<{ namespace: string; id: string }> = [],
) {
  return (await t.market.companies.createFromCandidate({ name, domain, externalIds }))!;
}

const companyCount = () => t.market.companies.col.countDocuments({});
const byName = async (name: string) => t.market.companies.byStrictName(strictNameKey(name));

describe('board file import: a live board anchors a company (OPS-1b)', () => {
  let source: SourceDoc;
  const ids: Record<string, string> = {};
  const CSV = [
    'Provider,Token,Company,Domain,Link',
    'greenhouse,a-owned,Owner Alias,,', // a: the board is Acme's source → unchanged
    'greenhouse,a-shared,,bee-ob1.co.uk,', // a: Acme's board, Bee's domain → owner review
    'lever,b-board,,bee-ob1.co.uk,', // b: domain → registered for Bee
    'greenhouse,C-Board,Sea Other Name,,', // c: ats id (any case) → registered for Sea
    'ashby,d-board,Dee Ob1 Co,,', // d: unique exact name → registered for Dee
    'greenhouse,e-board,Twin Ob1 Co,,', // e: two companies have this name → review
    'greenhouse,live-f1,Fresh Ob1 Co,,', // f: live → company created
    ',,Url Ob1 Co,,https://job-boards.eu.greenhouse.io/LiveUrl/jobs/123?gh_jid=123', // f from a URL (EU)
    'lever,dead-f2,Dead Ob1 Co,,', // not live (404)
    'ashby,down-f3,Down Ob1 Co,,', // unreachable (503, retried once)
    ',,,,https://jobs.lever.co/noname-f4', // no name, no domain, unknown board → no_identity
    ',,Junk Ob1 Co,,https://example.org/careers', // not an ATS URL → warning, row skipped
    'greenhouse,live-dup,Seven Ob1 AI,,', // created
    'greenhouse,LIVE-DUP,7 Ob1 AI,,', // the same board under another name → duplicate row
    'greenhouse,junk-f5,Junk Board Ob1,,', // 200 that does not parse → not live
  ].join('\n');

  beforeAll(async () => {
    const acme = await company('Acme Ob1 Co', 'acme-ob1.co.uk');
    const bee = await company('Bee Ob1 Co', 'bee-ob1.co.uk');
    const sea = await company('Sea Ob1 Co', null, [atsExternalId('greenhouse:c-board')]);
    const dee = await company('Dee Ob1 Co', null);
    const twinA = await company('Twin Ob1 Co', 'twin-a-ob1.co.uk');
    const twinB = await company('Twin Ob1 Holdings', 'twin-b-ob1.co.uk');
    await t.market.companies.col.updateOne(
      { _id: twinB._id },
      {
        $push: {
          'identity.aliases': { name: 'Twin Ob1 Co', strictKey: strictNameKey('Twin Ob1 Co'), sourceIds: [] },
        },
      },
    );
    Object.assign(ids, { acme: acme._id, bee: bee._id, sea: sea._id, dee: dee._id, twinA: twinA._id });
    for (const token of ['a-owned', 'a-shared'])
      await registerAtsBoard(
        t.market.sources,
        {
          company: acme,
          provider: 'greenhouse',
          boardToken: token,
          identity: atsBoardIdentity('greenhouse', token),
          refreshIntervalMinutes: 360,
          enableSchedule: false,
        },
        t.actor,
      );
    source = await boardSource('ob1');
  });

  it('resolves each row in order and creates companies only from live boards', async () => {
    const companiesBefore = await companyCount();
    const { report, outcomes } = await importFile(source, CSV);
    expect(report.counts).toEqual({
      rows: 15,
      parsed: 15,
      accepted: 9,
      created: 6,
      updated: 0,
      unchanged: 1,
      ignored: 2,
      failed: 4,
      // Twin review, Acme/Bee owner review, and the duplicate-row parser review.
      reviews: 3,
      warnings: 1,
    });
    expect(outcomes).toMatchObject({ companiesCreated: 3, notLive: 2, unreachable: 1, noIdentity: 1 });
    expect(report.trace.reportArtifactId).toEqual(expect.any(String));
    expect(await companyCount()).toBe(companiesBefore + 3);

    // Only rows with no match were fetched; the unreachable board was tried twice.
    expect([...fetched].sort()).toEqual(
      ['LiveUrl', 'dead-f2', 'down-f3', 'down-f3', 'junk-f5', 'live-dup', 'live-f1'].sort(),
    );

    const owner = async (key: string) => (await t.market.sources.getByKeyIgnoringCase(key))?.companyId;
    expect(await owner('greenhouse:a-owned')).toBe(ids.acme);
    expect(await owner('greenhouse:a-shared')).toBe(ids.acme);
    expect(await owner('lever:b-board')).toBe(ids.bee);
    expect(await owner('greenhouse:c-board')).toBe(ids.sea);
    expect(await owner('ashby:d-board')).toBe(ids.dee);
    for (const key of [
      'greenhouse:e-board',
      'lever:dead-f2',
      'ashby:down-f3',
      'lever:noname-f4',
      'greenhouse:junk-f5',
    ])
      expect(await t.market.sources.getByKeyIgnoringCase(key)).toBeNull();
    for (const name of ['Dead Ob1 Co', 'Down Ob1 Co', 'Junk Board Ob1', 'Junk Ob1 Co', '7 Ob1 AI'])
      expect(await byName(name)).toEqual([]);

    const reviews = await t.market.reviews.col.find({ _id: { $in: report.trace.reviewIds } }).toArray();
    expect(reviews.map((r) => r.type).sort()).toEqual([
      'careers_discovery',
      'company_resolution',
      'parser_failure',
    ]);
    const twin = reviews.find((r) => r.type === 'company_resolution')!;
    expect(twin.candidates.map((c) => c.id)).toContain(ids.twinA);

    const report_ = await infra.artifacts.readJson<{
      warnings: Array<{ line: number; code: string }>;
      rowFailures: Array<{ line: number; code: string }>;
    }>({ artifactId: report.trace.reportArtifactId! });
    expect(report_.warnings).toMatchObject([{ line: 13, code: 'not_an_ats_url' }]);
    expect(report_.rowFailures.map((f) => [f.line, f.code])).toEqual([
      [10, 'board_not_live'],
      [11, 'board_unreachable'],
      [12, 'no_identity'],
      [16, 'board_not_live'],
    ]);
  });

  it('gives a board-anchored company its ats id, its board and the board snapshot as provenance', async () => {
    const [fresh] = await byName('Fresh Ob1 Co');
    const doc = await t.market.companies.resolveActive(fresh!.id);
    expect(doc.identityKeys).toContain('ext:ats:greenhouse:live-f1');
    expect(doc.identity.externalIds).toContainEqual({ namespace: 'ats', id: 'greenhouse:live-f1' });
    const board = await t.market.sources.getByKey('greenhouse:live-f1');
    expect(board).toMatchObject({ companyId: doc._id, category: 'job_source' });
    // The liveness response is the board's first snapshot.
    const snaps = await t.market.observations.snapshots.find({ sourceId: board!._id }).toArray();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ via: 'http', httpStatus: 200 });
    const [event] = await t.market.audit.list({ entityKind: 'company', entityId: doc._id });
    expect(event).toMatchObject({
      action: 'company.created_from_ats_board',
      details: { board: 'greenhouse:live-f1', importSourceId: source._id, locator: 'row:8' },
    });
    expect(event!.details.boardArtifactId).toBe(snaps[0]!.artifact.artifactId);
    const obs = await t.market.observations.companyObservations
      .find({ sourceId: source._id, 'resolution.entityId': doc._id })
      .toArray();
    expect(obs.map((o) => o.resolution.method)).toEqual(['ats_board_live']);

    // The URL row: the board on the EU host, the token as written in the link.
    const [url] = await byName('Url Ob1 Co');
    expect(await t.market.sources.getByKey('greenhouse:eu:liveurl')).toMatchObject({
      companyId: url!.id,
      endpoint: { boardToken: 'LiveUrl' },
    });
    // The first of two names for one board wins.
    expect(await byName('Seven Ob1 AI')).toHaveLength(1);
  });

  it('re-importing the same file creates nothing and opens no review', async () => {
    const companies = await companyCount();
    const sources = await t.market.sources.col.countDocuments({ category: 'job_source' });
    const { report } = await importFile(source, CSV);
    expect(report.counts).toMatchObject({ created: 0, unchanged: 7, accepted: 9, failed: 4, reviews: 0 });
    expect(await companyCount()).toBe(companies);
    expect(await t.market.sources.col.countDocuments({ category: 'job_source' })).toBe(sources);
  });

  it('a later discovery of the same board registers no second source', async () => {
    const [fresh] = await byName('Fresh Ob1 Co');
    const { created, source: board } = await registerAtsBoard(
      t.market.sources,
      {
        company: await t.market.companies.resolveActive(fresh!.id),
        provider: 'greenhouse',
        boardToken: 'live-f1',
        identity: atsBoardIdentity('greenhouse', 'live-f1'),
        refreshIntervalMinutes: 360,
        enableSchedule: true,
      },
      t.actor,
    );
    expect(created).toBe(false);
    expect(board.companyId).toBe(fresh!.id);
    expect(await t.market.sources.col.countDocuments({ key: /^greenhouse:live-f1$/i })).toBe(1);
  });

  it('a board file row for a known board of a board-anchored company attaches, not duplicates', async () => {
    const [fresh] = await byName('Fresh Ob1 Co');
    // Another name for the same board in a new file: branch a keeps the board's company.
    const { report } = await importFile(
      await boardSource('ob1-later'),
      ['Provider,Token,Company,Domain,Link', 'greenhouse,LIVE-F1,Fresh Renamed Ob1,,'].join('\n'),
    );
    expect(report.counts).toMatchObject({ created: 0, unchanged: 1, failed: 0, reviews: 0 });
    expect(report.trace.companyIds).toEqual([fresh!.id]);
    expect(await byName('Fresh Renamed Ob1')).toHaveLength(0);
    expect(await t.market.companies.col.countDocuments({ identityKeys: 'ext:ats:greenhouse:live-f1' })).toBe(
      1,
    );
  });

  it('never creates a company from a bare name when the board is not live', async () => {
    const before = await companyCount();
    const { report } = await importFile(
      await boardSource('ob1-dead'),
      ['Provider,Token,Company,Domain,Link', 'greenhouse,dead-only,Bare Name Ob1,,'].join('\n'),
    );
    expect(report.counts).toMatchObject({ rows: 1, accepted: 0, failed: 1, reviews: 0 });
    expect(report.trace.reportArtifactId).toEqual(expect.any(String));
    expect(await companyCount()).toBe(before);
    expect(await t.market.companies.col.countDocuments({ 'identity.normalizedName': /bare name ob1/i })).toBe(
      0,
    );
  });
});

describe('board file import: repair repros (OPS-1b review)', () => {
  const HEAD = 'Provider,Token,Company,Domain,Link';
  const file = (...rows: string[]) => [HEAD, ...rows].join('\n');
  const owner = async (key: string) => (await t.market.sources.getByKey(key))?.companyId;
  const creationEvents = async (companyId: string) =>
    (await t.market.audit.list({ entityKind: 'company', entityId: companyId })).filter(
      (e) => e.action === 'company.created_from_ats_board',
    );

  it('H1: an EU board and a default-host board with one token are two companies (one file)', async () => {
    const before = await companyCount();
    const { report } = await importFile(
      await boardSource('rv-h1'),
      file(
        ',,Rv Acme Europe GmbH,,https://job-boards.eu.greenhouse.io/rvacme/jobs/1',
        ',,Rv Acme Incorporated,,https://boards.greenhouse.io/rvacme',
      ),
    );
    expect(report.counts).toMatchObject({ created: 2, failed: 0, reviews: 0 });
    expect(await companyCount()).toBe(before + 2);
    const [eu] = await byName('Rv Acme Europe GmbH');
    const [us] = await byName('Rv Acme Incorporated');
    expect(eu!.id).not.toBe(us!.id);
    expect(await owner('greenhouse:eu:rvacme')).toBe(eu!.id);
    expect(await owner('greenhouse:rvacme')).toBe(us!.id);
    expect((await t.market.companies.resolveActive(eu!.id)).identityKeys).toContain(
      'ext:ats:greenhouse:eu:rvacme',
    );
  });

  it('H1: the same two boards in two separate files are two companies', async () => {
    await importFile(
      await boardSource('rv-h1-a'),
      file(',,Rv Bcme Europe GmbH,,https://job-boards.eu.greenhouse.io/rvbcme/jobs/1'),
    );
    const { report } = await importFile(
      await boardSource('rv-h1-b'),
      file('greenhouse,rvbcme,Rv Bcme Incorporated,,'),
    );
    expect(report.counts).toMatchObject({ created: 1, reviews: 0 });
    const [eu] = await byName('Rv Bcme Europe GmbH');
    const [us] = await byName('Rv Bcme Incorporated');
    expect(eu!.id).not.toBe(us!.id);
    expect(await owner('greenhouse:eu:rvbcme')).toBe(eu!.id);
    expect(await owner('greenhouse:rvbcme')).toBe(us!.id);
  });

  it('H2: discovery registering the board during the liveness wait gives no second company', async () => {
    const x = await company('Xray Holdings Ob1', 'xray-ob1.co.uk');
    beforeReply.set('rvxray', async () => {
      await registerAtsBoard(
        t.market.sources,
        {
          company: x,
          provider: 'lever',
          boardToken: 'rvxray',
          identity: atsBoardIdentity('lever', 'rvxray'),
          refreshIntervalMinutes: 360,
          enableSchedule: false,
        },
        t.actor,
      );
    });
    const before = await companyCount();
    const { report } = await importFile(await boardSource('rv-h2'), file('lever,rvxray,Rv Xray Ob1,,'));
    beforeReply.delete('rvxray');
    // The row decides again and finds the board's company (branch a): nothing is created.
    expect(report.counts).toMatchObject({ created: 0, unchanged: 1, failed: 0 });
    expect(await companyCount()).toBe(before);
    expect(await byName('Rv Xray Ob1')).toEqual([]);
    expect(await owner('lever:rvxray')).toBe(x._id);
    expect(
      await t.market.companies.col.countDocuments({ identityKeys: 'ext:ats:lever:rvxray' }),
    ).toBeLessThan(2);
  });

  it('H3: a board source with no company is attached to the company the row creates', async () => {
    const planned = await company('Rv Orphan Seed Ob1', null);
    const { source: orphan } = await registerAtsBoard(
      t.market.sources,
      {
        company: planned,
        provider: 'greenhouse',
        boardToken: 'rvorphan',
        identity: atsBoardIdentity('greenhouse', 'rvorphan'),
        refreshIntervalMinutes: 360,
        enableSchedule: false,
      },
      t.actor,
    );
    await t.market.sources.col.updateOne({ _id: orphan._id }, { $unset: { companyId: '' } });
    await t.market.companies.col.deleteOne({ _id: planned._id });

    const before = await companyCount();
    const { report } = await importFile(
      await boardSource('rv-h3'),
      file('greenhouse,rvorphan,Rv Orphan Ob1,,'),
    );
    expect(report.counts).toMatchObject({ created: 1, failed: 0, reviews: 0 });
    expect(await companyCount()).toBe(before + 1);
    const [made] = await byName('Rv Orphan Ob1');
    expect(await owner('greenhouse:rvorphan')).toBe(made!.id);
    expect(await t.market.sources.col.countDocuments({ key: 'greenhouse:rvorphan' })).toBe(1);
    const events = await t.market.audit.list({ entityKind: 'source', entityId: orphan._id });
    expect(events.map((e) => e.action)).toContain('source.owner_changed');
  });

  it('H3: a board source with no company is attached to the company the row matches', async () => {
    const match = await company('Rv Orphan Match Ob1', null);
    const { source: orphan } = await registerAtsBoard(
      t.market.sources,
      {
        company: match,
        provider: 'lever',
        boardToken: 'rvorphan2',
        identity: atsBoardIdentity('lever', 'rvorphan2'),
        refreshIntervalMinutes: 360,
        enableSchedule: false,
      },
      t.actor,
    );
    await t.market.sources.col.updateOne({ _id: orphan._id }, { $unset: { companyId: '' } });
    const before = await companyCount();
    const { report } = await importFile(
      await boardSource('rv-h3-match'),
      file('lever,rvorphan2,Rv Orphan Match Ob1,,'),
    );
    expect(report.counts).toMatchObject({ failed: 0, reviews: 0 });
    expect(await companyCount()).toBe(before);
    expect(await owner('lever:rvorphan2')).toBe(match._id);
  });

  it('M1: a board file is never official evidence', async () => {
    await expect(
      t.market.sources.register(
        {
          key: 'boards:rv-m1-refused',
          name: 'rv m1',
          category: 'manual_import',
          provider: 'ats_board_directory',
          acquisition: {
            workflowKey: 'market.ats_boards.import',
            config: { columns: { provider: 'Provider', token: 'Token', company: 'Company' } },
          },
          authority: { tier: 'official_ats', authoritativeFor: [], listingIsComplete: false },
          freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
          governance: { accessMethod: 'manual_upload' },
        },
        t.actor,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const src = await boardSource('rv-m1');
    await expect(
      t.market.sources.update(src._id, { authority: { tier: 'official_ats' } } as never, t.actor),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    // A source stored before the rule with an official tier still yields third_party facts.
    await t.market.sources.col.updateOne({ _id: src._id }, { $set: { 'authority.tier': 'official_ats' } });
    await importFile(src, file('ashby,rvofficial,Rv Official Ob1,rv-official-ob1.co.uk,'));
    const [made] = await byName('Rv Official Ob1');
    const doc = await t.market.companies.resolveActive(made!.id);
    expect(doc.identity.displayName.value).toBe('Rv Official Ob1');
    expect(JSON.stringify(doc)).not.toContain('official_ats');
    expect(JSON.stringify(doc)).toContain('third_party');
  });

  it('M2: a retry after a failed link keeps the board snapshot as provenance', async () => {
    const obs = t.market.observations;
    const original = obs.setCompanyResolution.bind(obs);
    let armed = true;
    obs.setCompanyResolution = (async (...args: Parameters<typeof original>) => {
      if (armed && args[1].state === 'resolved') {
        armed = false;
        throw new Error('injected link failure');
      }
      return original(...args);
    }) as typeof original;
    const src = await boardSource('rv-m2');
    try {
      await importFile(src, file('greenhouse,rvcrash,Rv Crash Ob1,,'));
    } finally {
      obs.setCompanyResolution = original;
    }
    expect(armed).toBe(false);
    await importFile(src, file('greenhouse,rvcrash,Rv Crash Ob1,,'));

    const [made] = await byName('Rv Crash Ob1');
    expect(await owner('greenhouse:rvcrash')).toBe(made!.id);
    const board = await t.market.sources.getByKey('greenhouse:rvcrash');
    const snaps = await t.market.observations.snapshots.find({ sourceId: board!._id }).toArray();
    expect(snaps.length).toBeGreaterThan(0);
    const events = await creationEvents(made!.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.details.boardArtifactId).toEqual(expect.any(String));
    expect(snaps.map((s) => s.artifact.artifactId)).toContain(events[0]!.details.boardArtifactId);
    const linked = await t.market.observations.companyObservations.countDocuments({
      sourceId: src._id,
      'resolution.entityId': made!.id,
    });
    expect(linked).toBe(1);
  });

  it('two concurrent files with one board create one company and one creation event', async () => {
    // Hold the first fetch until the second arrives (or 3 s pass), so both runs overlap.
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    let seen = 0;
    beforeReply.set('rvtwin', async () => {
      if (++seen >= 2) return release();
      await Promise.race([both, new Promise((r) => setTimeout(r, 3000))]);
    });
    const [a, b] = await Promise.all([
      boardSource('rv-twin-a').then((s) => importFile(s, file('greenhouse,rvtwin,Rv Twin One Ob1,,'))),
      boardSource('rv-twin-b').then((s) => importFile(s, file('greenhouse,rvtwin,Rv Twin Two Ob1,,'))),
    ]);
    beforeReply.delete('rvtwin');
    expect(a.report.counts.failed + b.report.counts.failed).toBe(0);
    const holders = await t.market.companies.col
      .find({ identityKeys: 'ext:ats:greenhouse:rvtwin' })
      .toArray();
    expect(holders).toHaveLength(1);
    expect(await owner('greenhouse:rvtwin')).toBe(holders[0]!._id);
    expect(await creationEvents(holders[0]!._id)).toHaveLength(1);
    expect(await t.market.sources.col.countDocuments({ key: 'greenhouse:rvtwin' })).toBe(1);
  });

  it('lows: an HTML 200 or an off-host redirect is unreachable; an Ashby name with a space is live', async () => {
    scopes.length = 0;
    const { report } = await importFile(
      await boardSource('rv-lows'),
      file(
        'greenhouse,htmlpage,Rv Html Ob1,,',
        'lever,hopaway,Rv Hop Ob1,,',
        'ashby,rv%20space%20board,Rv Space Ob1,,',
      ),
    );
    expect(report.counts).toMatchObject({ created: 1, failed: 2 });
    const full = await infra.artifacts.readJson<{ rowFailures: Array<{ line: number; code: string }> }>({
      artifactId: report.trace.reportArtifactId!,
    });
    expect(full.rowFailures.map((f) => [f.line, f.code])).toEqual([
      [2, 'board_unreachable'],
      [3, 'board_unreachable'],
    ]);
    expect(await byName('Rv Html Ob1')).toEqual([]);
    expect(await byName('Rv Hop Ob1')).toEqual([]);
    expect(fetched).toContain('rv space board');
    const [space] = await byName('Rv Space Ob1');
    expect(await owner('ashby:rv space board')).toBe(space!.id);
    // Every liveness request is scoped to the provider's API hosts.
    expect(scopes).toContainEqual({
      allowedHosts: ['api.lever.co', 'api.eu.lever.co'],
      allowSubdomains: false,
    });
  });
});

describe('board file import: second repair repros (OPS-1b verification)', () => {
  const HEAD = 'Provider,Token,Company,Domain,Link';
  const file = (...rows: string[]) => [HEAD, ...rows].join('\n');
  const sourcesLike = (key: string) =>
    t.market.sources.col.find({ key: new RegExp(`^${key}$`, 'i') }).toArray();
  const register = async (
    c: Awaited<ReturnType<typeof company>>,
    provider: 'lever' | 'greenhouse',
    token: string,
  ) =>
    registerAtsBoard(
      t.market.sources,
      {
        company: c,
        provider,
        boardToken: token,
        identity: atsBoardIdentity(provider, token),
        refreshIntervalMinutes: 360,
        enableSchedule: false,
      },
      t.actor,
    );

  it('A: discovery registering a mixed-case token during the liveness wait gives one source, no company', async () => {
    const x = await company('Case Holdings Ob1', 'case-ob1.co.uk');
    beforeReply.set('rvcase', async () => void (await register(x, 'lever', 'RvCase')));
    const before = await companyCount();
    const { report } = await importFile(await boardSource('rv-a'), file('lever,rvcase,Rv Case New Ob1,,'));
    beforeReply.delete('rvcase');
    expect(report.counts).toMatchObject({ created: 0, failed: 0 });
    expect(await companyCount()).toBe(before);
    const boards = await sourcesLike('lever:rvcase');
    expect(boards.map((b) => [b.key, b.companyId, b.endpoint.boardToken])).toEqual([
      ['lever:rvcase', x._id, 'RvCase'],
    ]);
  });

  it('F: discovery of a mixed-case token after the import finds the imported board', async () => {
    await importFile(await boardSource('rv-f'), file('greenhouse,rvseq,Rv Seq Ob1,,'));
    const [made] = await byName('Rv Seq Ob1');
    const x = await company('Seq Holdings Ob1', 'seq-ob1.co.uk');
    const { created, source } = await register(x, 'greenhouse', 'RvSeq');
    expect(created).toBe(false);
    expect(source.companyId).toBe(made!.id);
    expect(await sourcesLike('greenhouse:rvseq')).toHaveLength(1);
  });

  it('register finds a source stored under an older mixed-case key', async () => {
    const x = await company('Old Key Holdings Ob1', 'oldkey-ob1.co.uk');
    const { source: old } = await t.market.sources.register(
      {
        key: 'lever:RvOld',
        name: 'Old key board',
        category: 'job_source',
        provider: 'lever',
        endpoint: { url: 'https://api.lever.co/v0/postings/RvOld?mode=json', boardToken: 'RvOld' },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId: x._id,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', authoritativeFor: [], listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    );
    const { created, source } = await register(x, 'lever', 'rvold');
    expect(created).toBe(false);
    expect(source._id).toBe(old._id);
    expect(await sourcesLike('lever:rvold')).toHaveLength(1);
  });

  it('B: a crash between claim and create leaves the board unscheduled; the re-import heals and schedules it', async () => {
    const companies = t.market.companies;
    const original = companies.createFromCandidate.bind(companies);
    // Every attempt of the first run crashes (the step's own retries included).
    let crashes = 0;
    companies.createFromCandidate = (async (...args: Parameters<typeof original>) => {
      if (args[1]?.id) {
        crashes++;
        throw new Error('injected crash after the claim');
      }
      return original(...args);
    }) as typeof original;
    const src = await boardSource('rv-b');
    try {
      await importFile(src, file('greenhouse,rvcrashb,Rv Crash B Ob1,,'));
    } finally {
      companies.createFromCandidate = original;
    }
    expect(crashes).toBeGreaterThan(0);
    const anchoredId = deterministicId('cmp', 'ats_board', 'greenhouse:rvcrashb');
    const claimed = await t.market.sources.getByKey('greenhouse:rvcrashb');
    expect(claimed).toMatchObject({ companyId: anchoredId });
    expect(claimed!.schedule).toBeUndefined();
    expect(await t.market.companies.col.findOne({ _id: anchoredId })).toBeNull();

    await importFile(src, file('greenhouse,rvcrashb,Rv Crash B Ob1,,'));
    expect(await t.market.companies.col.findOne({ _id: anchoredId })).not.toBeNull();
    const healed = await t.market.sources.getByKey('greenhouse:rvcrashb');
    expect(healed).toMatchObject({ companyId: anchoredId, schedule: { intervalMinutes: 360 } });
  });

  it('B2: a crash between create and schedule; the re-import schedules the board', async () => {
    const sources = t.market.sources;
    const original = sources.update.bind(sources);
    let crashes = 0;
    sources.update = (async (...args: Parameters<typeof original>) => {
      if (args[1]?.schedule) {
        crashes++;
        throw new Error('injected crash before the schedule');
      }
      return original(...args);
    }) as typeof original;
    const src = await boardSource('rv-b2');
    try {
      await importFile(src, file('greenhouse,rvcrashb2,Rv Crash B2 Ob1,,'));
    } finally {
      sources.update = original;
    }
    expect(crashes).toBeGreaterThan(0);
    const anchoredId = deterministicId('cmp', 'ats_board', 'greenhouse:rvcrashb2');
    expect(await t.market.companies.col.findOne({ _id: anchoredId })).not.toBeNull();
    expect((await sources.getByKey('greenhouse:rvcrashb2'))!.schedule).toBeUndefined();

    await importFile(src, file('greenhouse,rvcrashb2,Rv Crash B2 Ob1,,'));
    const healed = await sources.getByKey('greenhouse:rvcrashb2');
    expect(healed).toMatchObject({ companyId: anchoredId, schedule: { intervalMinutes: 360 } });
  });

  it('C: a claim released after a name clash stays unowned and unscheduled', async () => {
    beforeReply.set('rvclash', async () => {
      await company('Rv Clash Ob1', 'rv-clash-other-ob1.co.uk');
    });
    const { report } = await importFile(
      await boardSource('rv-c'),
      file('greenhouse,rvclash,Rv Clash Ob1,rv-clash-ob1.co.uk,'),
    );
    beforeReply.delete('rvclash');
    expect(report.counts).toMatchObject({ created: 0, reviews: 1 });
    expect(await byName('Rv Clash Ob1')).toHaveLength(1);
    const board = await t.market.sources.getByKey('greenhouse:rvclash');
    expect(board!.companyId).toBeUndefined();
    expect(board!.schedule).toBeUndefined();
  });

  it('C: a released claim that a later decision attaches is scheduled then', async () => {
    let clash: Awaited<ReturnType<typeof company>> | undefined;
    beforeReply.set('rvclash2', async () => {
      clash = await company('Rv Clash Two Ob1', null);
    });
    await importFile(await boardSource('rv-c2'), file('greenhouse,rvclash2,Rv Clash Two Ob1,,'));
    beforeReply.delete('rvclash2');
    expect(await byName('Rv Clash Two Ob1')).toHaveLength(1);
    const board = await t.market.sources.getByKey('greenhouse:rvclash2');
    expect(board).toMatchObject({ companyId: clash!._id, schedule: { intervalMinutes: 360 } });
  });

  it('an owner change and its audit event commit together', async () => {
    const x = await company('Atomic Owner Ob1', 'atomic-ob1.co.uk');
    const { source } = await register(x, 'lever', 'rvatomic');
    await t.market.sources.col.updateOne({ _id: source._id }, { $unset: { companyId: '' } });
    const audit = t.market.audit;
    const original = audit.record.bind(audit);
    let armed = true;
    audit.record = (async (...args: Parameters<typeof original>) => {
      if (armed && args[0].action === 'source.owner_changed') {
        armed = false;
        throw new Error('injected audit failure');
      }
      return original(...args);
    }) as typeof original;
    try {
      await expect(t.market.sources.setOwnerIf(source._id, null, x._id, t.actor, 'test')).rejects.toThrow(
        /injected/,
      );
    } finally {
      audit.record = original;
    }
    expect((await t.market.sources.get(source._id)).companyId).toBeUndefined();
    expect(await t.market.sources.setOwnerIf(source._id, null, x._id, t.actor, 'test')).toBe(true);
    expect((await t.market.sources.get(source._id)).companyId).toBe(x._id);
    const events = await t.market.audit.list({ entityKind: 'source', entityId: source._id });
    expect(events.filter((e) => e.action === 'source.owner_changed')).toHaveLength(1);
  });
});
