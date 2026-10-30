/**
 * OPS-1: import reports (counts and trace) of a company directory import, careers discovery
 * queued after it, the known ATS board file import (M8.2) and the discovery schedule. Real
 * MongoDB/Redis/S3; the web is answered offline (every non-loopback request is a 404).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SafeHttpClient, SafeRequest } from '@aptamind/net';
import { createTestInfra, type TestInfra, waitForRun } from '@aptamind/testing';
import { NET_CLIENT } from '@aptamind/workflow-nodes';
import { companiesCollection } from './companies/company.schema';
import type { ImportReport } from './imports/import-report';
import { registerAtsBoard, atsBoardIdentity } from './sources/board-registration';
import type { SourceDoc } from './sources/source.schema';
import { ensureSystemSources, SCHEDULE_SEEDED_LABEL } from './system-sources';
import { createMarketTestRuntime } from './test-harness';
import { installOfflineHttp } from './test-offline-http';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let webRequests: string[];

beforeAll(async () => {
  infra = await createTestInfra('ops_imports');
  t = await createMarketTestRuntime(infra);
  webRequests = installOfflineHttp(t.runtime);
});

afterAll(async () => {
  await t?.stop();
  await infra?.cleanup();
});

async function directorySource(key: string): Promise<SourceDoc> {
  return (
    await t.market.sources.register(
      {
        key: `directory:${key}`,
        name: `${key} directory`,
        category: 'company_universe',
        provider: 'company_directory',
        acquisition: {
          workflowKey: 'market.company_directory.import',
          config: { columns: { name: 'Company', domain: 'Domain' } },
        },
        freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
        governance: { accessMethod: 'manual_upload' },
      },
      t.actor,
    )
  ).source;
}

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
          config: { columns: { provider: 'Provider', token: 'Token', company: 'Company', domain: 'Domain' } },
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
  const report = (run.output as { importReport: ImportReport }).importReport;
  return { run, report, upload };
}

const companyId = async (domain: string) => (await t.market.companies.byIdentityKey(`domain:${domain}`))!.id;

describe('company directory import report and discovery (OPS-1)', () => {
  const CSV = [
    'Company,Domain',
    'Orbit Labs,orbit-labs-ops1.co.uk',
    'Nimbus Data,nimbus-data-ops1.co.uk',
    'Plain Co,',
    'Orbit Labs,orbit-labs-ops1.co.uk',
    ',empty-name-ops1.co.uk',
  ].join('\n');
  let source: SourceDoc;
  let firstRunId: string;

  it('reports counts and trace, and queues discovery for created companies with a domain', async () => {
    source = await directorySource('ops1');
    const { run, report } = await importFile(source, CSV);
    firstRunId = run._id;
    // Plain Co has no domain: a bare name is never created automatically (a review).
    expect(report.counts).toEqual({
      rows: 5,
      parsed: 5,
      accepted: 3,
      created: 2,
      updated: 0,
      unchanged: 0,
      ignored: 1,
      failed: 1,
      reviews: 2,
      // One file warning: no id column is mapped.
      warnings: 1,
    });
    expect(report.trace.reportArtifactId).toEqual(expect.any(String));
    expect(report.trace.companyIds).toHaveLength(2);
    expect(report.trace.reviewIds).toHaveLength(2);
    expect(report.trace.truncated).toBe(false);

    // One batch run per 100 due companies, keyed by the import run: the two with a domain.
    const batch = await t.runtime.engine.runs.findOne({
      idempotencyKey: `careers_discovery:import:${run._id}:0`,
    });
    expect(batch).not.toBeNull();
    expect((batch!.input as { companyIds: string[] }).companyIds.sort()).toEqual(
      [await companyId('orbit-labs-ops1.co.uk'), await companyId('nimbus-data-ops1.co.uk')].sort(),
    );
    const done = await waitForRun(t.runtime.engine, batch!._id, undefined, 60_000);
    expect(done.state).toBe('COMPLETED');
    expect(webRequests.some((u) => u.includes('orbit-labs-ops1.co.uk'))).toBe(true);
    const tried = await infra.db.collection(companiesCollection.name).countDocuments({
      _id: { $in: report.trace.companyIds },
      'freshness.careersCheckedAt': { $exists: true },
    } as never);
    expect(tried).toBe(2);
  });

  it('re-importing the same file creates nothing and queues no discovery', async () => {
    const { run, report } = await importFile(source, CSV);
    expect(run._id).not.toBe(firstRunId);
    expect(report.counts).toMatchObject({
      rows: 5,
      created: 0,
      updated: 0,
      unchanged: 2,
      ignored: 1,
      failed: 1,
      // The two reviews were opened by the first import, not this one.
      reviews: 0,
    });
    expect(report.trace.reviewIds).toEqual([]);
    expect(
      await t.runtime.engine.runs.countDocuments({ idempotencyKey: `careers_discovery:import:${run._id}:0` }),
    ).toBe(0);
  });

  it('selects only companies with a domain never tried or tried more than 30 days ago', async () => {
    const orbit = await companyId('orbit-labs-ops1.co.uk');
    const nimbus = await companyId('nimbus-data-ops1.co.uk');
    const companies = infra.db.collection(companiesCollection.name);
    // Both were tried just now.
    expect(await t.market.freshness.filterDueForCareersDiscovery([orbit, nimbus])).toEqual([]);
    const longAgo = new Date(Date.now() - 31 * 86_400_000);
    await companies.updateMany({ _id: { $in: [orbit, nimbus] } } as never, {
      $set: { 'freshness.careersCheckedAt': longAgo },
    });
    // A company without a domain is never selected (fixture edit: no import yields one here).
    await companies.updateOne({ _id: nimbus } as never, { $set: { 'identity.domain.value': null } });
    expect(await t.market.freshness.filterDueForCareersDiscovery([orbit, nimbus])).toEqual([orbit]);
    const due = await t.market.freshness.companiesWithDomainDueForCareers(1000);
    expect(due).toContain(orbit);
    expect(due).not.toContain(nimbus);
    const indexes = await companies.indexes();
    expect(indexes.map((i) => i.name)).toContain('by_careers_due_with_domain');
  });

  it('gives the careers discovery system source an hourly schedule', async () => {
    const source = await t.market.sources.getByKey('system:careers-discovery');
    expect(source?.schedule).toMatchObject({ intervalMinutes: 60 });
    const schedule = await infra.db
      .collection('workflow_schedules')
      .findOne({ 'owner.kind': 'source', 'owner.id': source!._id });
    expect(schedule).toMatchObject({
      enabled: true,
      intervalMinutes: 60,
      workflowKey: 'market.careers_discovery.batch',
    });
  });
});

describe('known ATS board file import (M8.2)', () => {
  let source: SourceDoc;
  let acme: string;
  let beta: string;
  const CSV = [
    'Provider,Token,Company,Domain',
    'greenhouse,acmeboard,,acme-ats-ops1.co.uk', // resolved by domain → registered
    'Lever,betaboard,Beta Ats Co,', // resolved by unique exact name → registered
    // The domain matches nobody, but Beta has the name → review, nothing registered (OPS-1b).
    'ashby,nobodyboard,Beta Ats Co,nobody-ats-ops1.co.uk',
    'greenhouse,sharedboard,,beta-ats-ops1.co.uk', // board owned by Acme → review
    'greenhouse,acmeboard,,acme-ats-ops1.co.uk', // duplicate row → ignored
    'workday,x1,,acme-ats-ops1.co.uk', // unknown provider → failed
  ].join('\n');

  beforeAll(async () => {
    await importFile(
      await directorySource('ats-companies'),
      ['Company,Domain', 'Acme Ats Co,acme-ats-ops1.co.uk', 'Beta Ats Co,beta-ats-ops1.co.uk'].join('\n'),
    );
    acme = await companyId('acme-ats-ops1.co.uk');
    beta = await companyId('beta-ats-ops1.co.uk');
    await registerAtsBoard(
      t.market.sources,
      {
        company: await t.market.companies.resolveActive(acme),
        provider: 'greenhouse',
        boardToken: 'sharedboard',
        identity: atsBoardIdentity('greenhouse', 'sharedboard'),
        refreshIntervalMinutes: 360,
        enableSchedule: false,
      },
      t.actor,
    );
    source = await boardSource('ops1');
  });

  it('registers resolved boards and reviews unresolved and other-owner rows', async () => {
    const { report } = await importFile(source, CSV);
    expect(report.counts).toEqual({
      rows: 6,
      parsed: 6,
      accepted: 4,
      created: 2,
      updated: 0,
      unchanged: 0,
      ignored: 1,
      failed: 1,
      reviews: 3,
      warnings: 0,
    });
    expect(report.trace.reportArtifactId).toEqual(expect.any(String));
    const acmeBoard = await t.market.sources.getByKey('greenhouse:acmeboard');
    const betaBoard = await t.market.sources.getByKey('lever:betaboard');
    expect(acmeBoard).toMatchObject({ companyId: acme, category: 'job_source', provider: 'greenhouse' });
    expect(betaBoard).toMatchObject({ companyId: beta, provider: 'lever' });
    expect(await t.market.sources.getByKey('ashby:nobodyboard')).toBeNull();
    // The shared board still belongs to Acme.
    expect((await t.market.sources.getByKey('greenhouse:sharedboard'))?.companyId).toBe(acme);
    expect(report.trace.sourceIds).toEqual(expect.arrayContaining([acmeBoard!._id, betaBoard!._id]));

    const reviews = await t.market.reviews.col.find({ _id: { $in: report.trace.reviewIds } }).toArray();
    expect(reviews.map((r) => r.type).sort()).toEqual([
      'careers_discovery',
      'company_resolution',
      'parser_failure',
    ]);
    const unresolved = reviews.find((r) => r.type === 'company_resolution')!;
    expect(unresolved.allowedActions).toEqual(['merge', 'reject', 'dismiss']);
    expect(unresolved.evidence[0]).toMatchObject({ sourceId: source._id, locator: 'row:4' });
  });

  it('re-importing the same file changes nothing', async () => {
    const before = await t.market.sources.col.countDocuments({ category: 'job_source' });
    const { report } = await importFile(source, CSV);
    expect(report.counts).toMatchObject({
      created: 0,
      unchanged: 2,
      accepted: 4,
      ignored: 1,
      failed: 1,
      // The same three reviews are still open; this import opened none of them.
      reviews: 0,
    });
    expect(report.trace.reviewIds).toEqual([]);
    expect(await t.market.sources.col.countDocuments({ category: 'job_source' })).toBe(before);
  });
});

describe('board file: other owner and token case (OPS-1 repair)', () => {
  let acme: string;
  let beta: string;

  beforeAll(async () => {
    await importFile(
      await directorySource('zz-companies'),
      ['Company,Domain', 'Zz Acme,zz-acme.co.uk', 'Zz Beta,zz-beta.co.uk'].join('\n'),
    );
    acme = await companyId('zz-acme.co.uk');
    beta = await companyId('zz-beta.co.uk');
    for (const token of ['zzshared', 'ZZMixed'])
      await registerAtsBoard(
        t.market.sources,
        {
          company: await t.market.companies.resolveActive(acme),
          provider: 'greenhouse',
          boardToken: token,
          identity: atsBoardIdentity('greenhouse', token),
          refreshIntervalMinutes: 360,
          enableSchedule: false,
        },
        t.actor,
      );
  });

  it('a board owned by another company changes no company record', async () => {
    const before = await t.market.companies.resolveActive(beta);
    const { report } = await importFile(
      await boardSource('zz-shared'),
      ['Provider,Token,Company,Domain', 'greenhouse,zzshared,,zz-beta.co.uk'].join('\n'),
    );
    expect(report.counts).toMatchObject({ rows: 1, created: 0, unchanged: 0, reviews: 1 });
    const after = await t.market.companies.resolveActive(beta);
    expect(after.employment.ats).toEqual(before.employment.ats);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect((await t.market.sources.getByKey('greenhouse:zzshared'))?.companyId).toBe(acme);
    const [review] = await t.market.reviews.col.find({ _id: { $in: report.trace.reviewIds } }).toArray();
    expect(review?.type).toBe('careers_discovery');
  });

  it('matches board tokens case-insensitively and keeps the first-seen token', async () => {
    const { report } = await importFile(
      await boardSource('zz-case'),
      [
        'Provider,Token,Company,Domain',
        'greenhouse,zzmixed,,zz-acme.co.uk', // the registered greenhouse:ZZMixed → unchanged
        'lever,ZZCase,,zz-acme.co.uk', // new board → registered as lever:zzcase
        'lever,zzcase,,zz-acme.co.uk', // same board, other case → duplicate row
      ].join('\n'),
    );
    expect(report.counts).toMatchObject({ rows: 3, created: 1, unchanged: 1, ignored: 1, failed: 0 });
    expect(await t.market.sources.col.countDocuments({ key: /^greenhouse:zzmixed$/i })).toBe(1);
    const lever = await t.market.sources.getByKey('lever:zzcase');
    expect(lever).toMatchObject({ companyId: acme, endpoint: { boardToken: 'ZZCase' } });
    expect(await t.market.sources.col.countDocuments({ key: /^lever:zzcase$/i })).toBe(1);
  });
});

describe('careers discovery that throws (OPS-1 repair)', () => {
  it('records a failed attempt, so the next batch picks another company', async () => {
    const { run } = await importFile(
      await directorySource('zz-discovery'),
      ['Company,Domain', 'Zz Boom,zz-boom.co.uk', 'Zz Calm,zz-calm.co.uk'].join('\n'),
    );
    const batch = await t.runtime.engine.runs.findOne({
      idempotencyKey: `careers_discovery:import:${run._id}:0`,
    });
    await waitForRun(t.runtime.engine, batch!._id, undefined, 60_000);
    const boom = await companyId('zz-boom.co.uk');
    const calm = await companyId('zz-calm.co.uk');
    // Both due again, as if last tried long ago.
    await infra.db.collection(companiesCollection.name).updateMany({ _id: { $in: [boom, calm] } } as never, {
      $set: { 'freshness.careersCheckedAt': new Date(Date.now() - 31 * 86_400_000) },
    });

    const offline = t.runtime.services.get(NET_CLIENT);
    const throwing = new Proxy(offline, {
      get(target, prop, receiver) {
        if (prop !== 'request') return Reflect.get(target, prop, receiver) as unknown;
        return (req: SafeRequest) =>
          new URL(req.url).hostname.endsWith('zz-boom.co.uk')
            ? Promise.reject(new Error('simulated client crash'))
            : target.request(req);
      },
    }) as SafeHttpClient;
    t.runtime.services.register(NET_CLIENT, throwing);
    try {
      const started = await t.runtime.engine.startRun({
        workflowKey: 'market.company.discover_careers',
        input: { companyId: boom },
        trigger: { kind: 'manual' },
      });
      const done = await waitForRun(t.runtime.engine, started._id, undefined, 60_000);
      expect(done.state).toBe('FAILED');
    } finally {
      t.runtime.services.register(NET_CLIENT, offline);
    }
    const company = await t.market.companies.resolveActive(boom);
    expect(company.freshness.careersDiscoveryStatus).toBe('failed');
    expect(company.freshness.careersCheckedAt!.getTime()).toBeGreaterThan(Date.now() - 120_000);
    expect(await t.market.freshness.filterDueForCareersDiscovery([boom, calm])).toEqual([calm]);
    expect(await t.market.freshness.companiesWithDomainDueForCareers(1000)).not.toContain(boom);
  });
});

describe('system source schedule seeding (OPS-1 repair)', () => {
  it('seeds the discovery schedule once and never puts it back after an operator removes it', async () => {
    const source = (await t.market.sources.getByKey('system:careers-discovery'))!;
    expect(source.labels[SCHEDULE_SEEDED_LABEL]).toBe('true');
    await t.market.sources.update(source._id, { schedule: null }, t.actor);
    await ensureSystemSources(t.market.sources);
    expect((await t.market.sources.get(source._id)).schedule).toBeUndefined();
  });
});
