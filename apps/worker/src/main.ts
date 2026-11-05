import { createPlatform } from '@aptamind/platform';
import { DEFAULT_CAPABILITY_QUEUES } from '@aptamind/workflows';
import { startHealthServer } from './health-server';
import { loadMcpConfig } from './mcp/config';
import { createMcpLimiters } from './mcp/rate-limit';
import { startMcpServer } from './mcp/server';

/**
 * Worker process: executes workflow nodes and fan-out chunks from the queues, fires
 * schedules, and runs the recovery sweeper. Scale horizontally by running more workers;
 * dedicate workers to capability classes with WORKER_QUEUES (e.g. `browser`, `ai`).
 */
const platform = await createPlatform('worker');
await platform.init();
const queues = platform.config.worker.queues.length
  ? platform.config.worker.queues
  : DEFAULT_CAPABILITY_QUEUES;
const host = platform.runtime.createWorkerHost({
  workerId: platform.workerId,
  queues,
  concurrency: platform.config.worker.concurrency,
  schedulerEnabled: platform.config.worker.schedulerEnabled,
  schedulerIntervalMs: platform.config.worker.schedulerIntervalMs,
  sweeperIntervalMs: platform.config.worker.sweeperIntervalMs,
  leaseMs: platform.config.worker.leaseMs,
});
let running = true;
host.start();
const health = platform.config.worker.metricsPort
  ? startHealthServer(platform, platform.config.worker.metricsPort, () => running)
  : null;
const mcpConfig = loadMcpConfig(process.env, platform.config.worker.metricsPort);
const mcp = mcpConfig.enabled
  ? await startMcpServer({
      platform,
      config: mcpConfig,
      logger: {
        error(obj, msg) {
          platform.logger.error(obj as object, msg);
        },
      },
      limiters: createMcpLimiters(),
    })
  : null;
platform.logger.info(
  {
    workerId: platform.workerId,
    queues,
    healthPort: platform.config.worker.metricsPort,
    ...(mcpConfig.enabled ? { mcpPort: mcpConfig.port } : {}),
  },
  'worker started',
);

async function shutdown(signal: string) {
  if (!running) process.exit(1); // second signal: stop now

  running = false;
  platform.logger.info(
    { signal },
    'worker shutting down (in-flight nodes finish or their leases expire and are recovered)',
  );
  // Stop taking MCP calls before the worker drains; never let a failed close skip the exit.
  const force = setTimeout(() => process.exit(1), 60_000);
  force.unref();
  try {
    await mcp
      ?.close()
      .catch((err: unknown) => platform.logger.error({ errName: (err as Error)?.name }, 'mcp close failed'));
    await host.stop();
    health?.close();
  } finally {
    await platform.close();
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
