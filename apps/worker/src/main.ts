import { createPlatform } from '@aptamind/platform';
import { DEFAULT_CAPABILITY_QUEUES } from '@aptamind/workflows';
import { startHealthServer } from './health-server';

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
platform.logger.info(
  { workerId: platform.workerId, queues, healthPort: platform.config.worker.metricsPort },
  'worker started',
);

async function shutdown(signal: string) {
  if (!running) return;
  running = false;
  platform.logger.info(
    { signal },
    'worker shutting down (in-flight nodes finish or their leases expire and are recovered)',
  );
  await host.stop();
  health?.close();
  await platform.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
