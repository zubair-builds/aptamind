// First: installs the egress guard before anything below is evaluated (LOW-3).
import { assertNoEgress } from './testing';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Actor, UNAUTHENTICATED_INTERNAL_OPERATOR } from '@aptamind/contracts';
import { createTestRuntime, type TestInfra, waitForRun } from '@aptamind/testing';
import type { WorkflowWorkerHost } from '@aptamind/workflows';
import { MARKET_FIXTURES_DIR } from './fixtures';
import { createMarketDomain, MARKET, type MarketDomain } from './market-domain';
import { uploadSnapshot } from './sources/snapshot-upload';
import { installEgressGuard } from './test-egress-guard';
import { marketCapabilities } from './workflow-nodes';
import { marketWorkflows } from './workflows';

/** Integration-test wiring of the Market domain onto a real runtime (Mongo/Redis/S3). */
export async function createMarketTestRuntime(infra: TestInfra, opts: { leaseMs?: number } = {}) {
  // No Market integration test may reach a non-loopback host (PR #11 re-verify #6 M-1).
  installEgressGuard();
  const runtime = createTestRuntime(infra, {
    capabilities: marketCapabilities,
    leaseMs: opts.leaseMs ?? 10_000,
  });
  const market: MarketDomain = createMarketDomain(
    { db: infra.db, clock: { now: () => new Date() }, logger: infra.logger, artifacts: infra.artifacts },
    {
      launcher: {
        startRun: (req) => runtime.engine.startRun({ ...req, input: JSON.parse(JSON.stringify(req.input)) }),
      },
      schedules: {
        upsert: (i) => runtime.scheduler.upsert({ ...i, input: JSON.parse(JSON.stringify(i.input ?? {})) }),
      },
      onReviewResolved: async (item, actor) => {
        await runtime.engine.resumeByCorrelationKey(item._id, { reviewItemId: item._id }, actor);
      },
    },
  );
  runtime.services.register(MARKET, market);
  await market.ensureReady();
  await runtime.registerWorkflows(marketWorkflows);
  const host: WorkflowWorkerHost = runtime.createWorkerHost({
    workerId: 'market-test',
    schedulerEnabled: false,
    sweeperIntervalMs: 500,
    concurrency: 8,
  });
  host.start();
  const actor: Actor = UNAUTHENTICATED_INTERNAL_OPERATOR;
  return {
    runtime,
    market,
    host,
    actor,
    fixture: (...p: string[]) => readFile(path.join(MARKET_FIXTURES_DIR, ...p)),
    async runSource(sourceId: string, extra: Record<string, unknown> = {}) {
      const { runId } = await market.sources.runNow(sourceId, actor, extra);
      return waitForRun(runtime.engine, runId, undefined, 60_000);
    },
    async upload(sourceId: string, body: Uint8Array | string, mime: string) {
      return uploadSnapshot(market, sourceId, body, mime, actor);
    },
    async stop() {
      await host.stop();
      await runtime.http.close();
      assertNoEgress();
    },
  };
}
