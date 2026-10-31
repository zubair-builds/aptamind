import { createPlatform } from '@aptamind/platform';
import { DEFAULT_CAPABILITY_QUEUES } from '@aptamind/workflows';
import { startHealthServer } from './health-server';
import { parsePublicPort, startPublicHealthServer } from './public-health-server';

/**
 * Worker process: executes workflow nodes and fan-out chunks from the queues, fires
 * schedules, and runs the recovery sweeper. Scale horizontally by running more workers;
 * dedicate workers to capability classes with WORKER_QUEUES (e.g. `browser`, `ai`).
 */
let running = true;
// PORT is set by hosts that need an open port (Render web service). Bound before platform
// init so the host's port scan passes during slow startup; if init fails the process exits.
// Serves only a static /healthz on 0.0.0.0; /ready and /metrics stay on the loopback server.
const publicPort = parsePublicPort(process.env.PORT);
const publicHealth = publicPort ? startPublicHealthServer(publicPort, () => running) : null;
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
host.start();
const metricsPort = platform.config.worker.metricsPort;
const metricsClash = publicPort !== null && metricsPort === publicPort;
if (metricsClash) {
  platform.logger.warn(
    { port: publicPort },
    'PORT equals WORKER_METRICS_PORT; loopback health/metrics server not started',
  );
}
const health = metricsPort && !metricsClash ? startHealthServer(platform, metricsPort, () => running) : null;
platform.logger.info(
  {
    workerId: platform.workerId,
    queues,
    healthPort: health ? metricsPort : null,
    publicHealthPort: publicPort,
  },
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
  publicHealth?.close();
  await platform.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
