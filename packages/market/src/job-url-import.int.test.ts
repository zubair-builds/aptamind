/**
 * OPS-5: job URL import. A CSV of job links → provider detection → company resolution → board
 * registration → an immediate listing refresh → canonical jobs. The web is offline except the
 * Greenhouse API of one board, answered from the committed fixture.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SafeHttpClient, SafeRequest } from '@aptamind/net';
import { createTestInfra, type TestInfra, waitForRun } from '@aptamind/testing';
import { NET_CLIENT } from '@aptamind/workflow-nodes';
import { MARKET_FIXTURES_DIR } from './fixtures';
import { checkImportTarget, createImport } from './imports/import.service';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';
import { offlineHttp } from './test-offline-http';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let listing: Uint8Array;
const apiHits: string[] = [];

beforeAll(async () => {
  infra = await createTestInfra('job_url_import');
  t = await createMarketTestRuntime(infra);
  listing = await readFile(path.join(MARKET_FIXTURES_DIR, 'ats/greenhouse/acme-listing-t1.json'));
  const { http: offline } = offlineHttp(t.runtime.http);
  const http = new Proxy(offline, {
    get(target, prop, receiver) {
      if (prop !== 'request') return Reflect.get(target, prop, receiver) as unknown;
      return async (req: SafeRequest) => {
        const u = new URL(req.url);
        if (
          u.hostname === 'boards-api.greenhouse.io' &&
          u.pathname.startsWith('/v1/boards/acmejobsops5/jobs')
        ) {
          apiHits.push(req.url);
          return {
            url: req.url,
            requestedUrl: req.url,
            status: 200,
            ok: true,
            headers: { 'content-type': 'application/json' },
            contentType: 'application/json',
            body: listing,
            redirects: [],
            fetchedAt: new Date(),
            durationMs: 1,
          };
        }
        return target.request(req);
      };
    },
  }) as SafeHttpClient;
  t.runtime.services.register(NET_CLIENT, http);
});

afterAll(async () => {
  await t?.stop();
  await infra?.cleanup();
});

async function jobUrlSource(key: string, columns: Record<string, string>): Promise<SourceDoc> {
  return (
    await t.market.sources.register(
      {
        key: `job-urls:${key}`,
        name: `${key} job urls`,
        category: 'manual_import',
        provider: 'ats_board_directory',
        acquisition: { workflowKey: 'market.ats_boards.import', config: { columns } },
        freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
        governance: { accessMethod: 'manual_upload' },
      },
      t.actor,
    )
  ).source;
}

describe('job URL import (OPS-5)', () => {
  it('refuses a job import whose source maps no url column', async () => {
    const s = await jobUrlSource('nourl', { provider: 'Provider', token: 'Token', company: 'Company' });
    await expect(checkImportTarget(t.market, 'jobs', s._id)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('turns job links into a company, a board source and canonical jobs', async () => {
    const source = await jobUrlSource('ops5', { url: 'URL', company: 'Company', domain: 'Domain' });
    const csv = [
      'URL,Company,Domain',
      'https://job-boards.greenhouse.io/acmejobsops5/jobs/4012345001,Acme Jobs Co,acme-jobs-ops5.co.uk',
      'https://job-boards.greenhouse.io/acmejobsops5/jobs/4012345002?gh_src=x,Acme Jobs Co,acme-jobs-ops5.co.uk',
      'https://example.com/careers/1,Nobody,',
    ].join('\n');
    const imp = await createImport(
      t.market,
      { type: 'jobs', sourceId: source._id, fileName: 'jobs.csv', body: csv, contentType: 'text/csv' },
      t.actor,
    );
    expect(imp.runId).toEqual(expect.any(String));
    const run = await waitForRun(t.runtime.engine, imp.runId!, undefined, 60_000);
    expect(run.state).toBe('COMPLETED');

    const board = await t.market.sources.getByKey('greenhouse:acmejobsops5');
    expect(board).toMatchObject({ category: 'job_source', provider: 'greenhouse' });
    expect(board!.companyId).toEqual(expect.any(String));

    const refresh = await t.runtime.engine.runs.findOne({
      idempotencyKey: `job_urls:${run._id}:${board!._id}`,
    });
    expect(refresh).not.toBeNull();
    const done = await waitForRun(t.runtime.engine, refresh!._id, undefined, 60_000);
    expect(done.state).toBe('COMPLETED');
    const jobs = await t.market.jobs.col.find({ companyId: board!.companyId }).toArray();
    expect(jobs.length).toBeGreaterThan(0);
    expect(apiHits.length).toBeGreaterThan(0);
  });

  it('a plain board import does not refresh', async () => {
    const source = await jobUrlSource('plain', { url: 'URL', company: 'Company', domain: 'Domain' });
    const imp = await createImport(
      t.market,
      {
        type: 'ats_boards',
        sourceId: source._id,
        body: 'URL,Company,Domain\nhttps://job-boards.greenhouse.io/acmejobsops5/jobs/1,Acme Jobs Co,acme-jobs-ops5.co.uk',
        contentType: 'text/csv',
      },
      t.actor,
    );
    const run = await waitForRun(t.runtime.engine, imp.runId!, undefined, 60_000);
    expect(run.state).toBe('COMPLETED');
    const board = await t.market.sources.getByKey('greenhouse:acmejobsops5');
    expect(
      await t.runtime.engine.runs.findOne({ idempotencyKey: `job_urls:${run._id}:${board!._id}` }),
    ).toBeNull();
  });
});
