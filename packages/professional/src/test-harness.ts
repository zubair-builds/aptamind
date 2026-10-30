import { type Actor, UNAUTHENTICATED_INTERNAL_OPERATOR } from '@aptamind/contracts';
import type { Logger } from '@aptamind/observability';
import { createTestRuntime, type TestInfra, waitForRun } from '@aptamind/testing';
import { DEFAULT_PROFESSIONAL_LIMITS, type RunLauncher } from './context';
import { createProfessionalDomain, PROFESSIONAL, type ProfessionalDomain } from './professional-domain';
import { professionalCapabilities } from './workflow-nodes';
import { professionalWorkflows } from './workflows';

/**
 * Integration-test wiring of the Professional domain onto a real runtime (Mongo/Redis/S3): the
 * same capabilities, workflows and launcher adapter as the platform composition root.
 */
export async function createProfessionalTestRuntime(
  infra: TestInfra,
  opts: { leaseMs?: number; logger?: Logger; launcher?: (real: RunLauncher) => RunLauncher } = {},
) {
  const runtime = createTestRuntime(infra, {
    capabilities: professionalCapabilities,
    leaseMs: opts.leaseMs ?? 10_000,
  });
  const real: RunLauncher = {
    startRun: (req) => runtime.engine.startRun({ ...req, input: JSON.parse(JSON.stringify(req.input)) }),
  };
  const professional: ProfessionalDomain = createProfessionalDomain(
    {
      db: infra.db,
      clock: { now: () => new Date() },
      logger: opts.logger ?? infra.logger,
      artifacts: infra.artifacts,
      config: { aiModel: 'fixture', limits: { ...DEFAULT_PROFESSIONAL_LIMITS } },
    },
    {
      launcher: opts.launcher ? opts.launcher(real) : real,
      runs: {
        states: async (ids) =>
          Object.fromEntries(
            (await runtime.engine.runs.find({ _id: { $in: [...ids] } }).toArray()).map((r) => [
              r._id,
              r.state,
            ]),
          ),
      },
    },
  );
  runtime.services.register(PROFESSIONAL, professional);
  await professional.ensureReady();
  await runtime.registerWorkflows(professionalWorkflows);
  const host = runtime.createWorkerHost({
    workerId: 'professional-test',
    schedulerEnabled: false,
    sweeperIntervalMs: 500,
    concurrency: 4,
  });
  host.start();
  const actor: Actor = UNAUTHENTICATED_INTERNAL_OPERATOR;
  return {
    runtime,
    professional,
    host,
    actor,
    wait: (runId: string) => waitForRun(runtime.engine, runId, undefined, 60_000),
    async stop() {
      await host.stop();
      await runtime.http.close();
    },
  };
}
