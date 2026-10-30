import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, type Platform } from '@aptamind/platform';
import { waitForRun } from '@aptamind/testing';
import { buildApp } from './app';

const suffix = randomBytes(4).toString('hex');
process.env.MONGODB_DB = `t_api_${suffix}`;
process.env.QUEUE_PREFIX = `t-api-${suffix}`;
process.env.S3_BUCKET = 'aptamind-test';
process.env.WORKER_METRICS_PORT = '0';

let worker: Platform;
let host: ReturnType<Platform['runtime']['createWorkerHost']>;

beforeAll(async () => {
  worker = await createPlatform('worker');
  await worker.init();
  host = worker.runtime.createWorkerHost({
    workerId: 'api-test-worker',
    schedulerEnabled: false,
    sweeperIntervalMs: 500,
  });
});

afterAll(async () => {
  await host?.stop();
  await worker?.mongo.db.dropDatabase().catch(() => {});
  await worker?.close();
});

describe('internal API', () => {
  it('serves health/readiness, applies the no-auth request context, and survives an API restart mid-run', async () => {
    const apiA = await createPlatform('api');
    await apiA.init();
    const appA = await buildApp(apiA);

    expect((await appA.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({ status: 'ok' });
    const ready = await appA.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks).toEqual({ mongo: true, redis: true, objectStorage: true });

    const caps = (await appA.inject({ method: 'GET', url: '/api/capabilities' })).json();
    expect(caps.items.map((c: { key: string }) => c.key)).toEqual(
      expect.arrayContaining([
        'core.for_each@1',
        'core.http_request@1',
        'market.process_sponsor_row@1',
        'market.verify_job@1',
      ]),
    );

    const created = await appA.inject({
      method: 'POST',
      url: '/api/sources',
      payload: {
        key: 'test:manual',
        name: 'Manual test source',
        category: 'manual_import',
        provider: 'manual',
        acquisition: { workflowKey: 'market.freshness.sweep' },
        freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 60 },
        authority: { tier: 'third_party' },
      },
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().source._id as string;
    const audit = (
      await appA.inject({ method: 'GET', url: `/api/audit?entityKind=source&entityId=${sourceId}` })
    ).json();
    expect(audit.items[0].actor).toEqual({
      kind: 'internal-operator',
      id: 'unauthenticated-internal-operator',
    });

    // Queue a run while no worker is consuming, then restart the API.
    const started = await appA.inject({ method: 'POST', url: `/api/sources/${sourceId}/run`, payload: {} });
    expect(started.statusCode).toBe(202);
    const { runId } = started.json() as { runId: string };
    await appA.close();
    await apiA.close();

    host.start();
    const apiB = await createPlatform('api');
    const appB = await buildApp(apiB);
    const done = await waitForRun(worker.runtime.engine, runId, undefined, 30_000);
    expect(done.state).toBe('COMPLETED');
    const detail = (await appB.inject({ method: 'GET', url: `/api/runs/${runId}` })).json();
    expect(detail.run.state).toBe('COMPLETED');
    expect(detail.run.labels.sourceId).toBe(sourceId);
    expect(detail.nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual(['trigger', 'sweep', 'evidence']);

    const dash = await appB.inject({ method: 'GET', url: '/api/dashboard' });
    expect(dash.statusCode).toBe(200);
    expect(dash.json()).toHaveProperty('review.open');
    const dq = await appB.inject({ method: 'GET', url: '/api/metrics/data-quality' });
    expect(dq.statusCode).toBe(200);

    const bad = await appB.inject({ method: 'GET', url: '/api/companies/cmp_missing' });
    expect(bad.statusCode).toBe(404);
    expect(bad.json().error.code).toBe('not_found');
    const invalid = await appB.inject({ method: 'POST', url: '/api/sources', payload: { key: 'x' } });
    expect(invalid.statusCode).toBe(400);
    await appB.close();
    await apiB.close();
  });
});
