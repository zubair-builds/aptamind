import type { Db } from 'mongodb';
import type { Clock } from '@aptamind/contracts';
import { systemClock } from '@aptamind/contracts';
import { ensureCollections } from '@aptamind/db';
import type { Logger, MetricsRegistry } from '@aptamind/observability';
import type { QueueTransport } from '@aptamind/queue';
import type { ArtifactStore } from '@aptamind/storage';
import { artifactsCollection } from '@aptamind/storage';
import { type AnyCapability, ServiceRegistry, type WorkflowSpec } from '@aptamind/workflow-sdk';
import { WorkflowCatalog } from './catalog';
import { forEachCapability } from './control';
import { BullMqDispatcher, type Dispatcher } from './dispatcher';
import { WorkflowEngine } from './engine';
import { WorkflowQueries } from './queries';
import { CapabilityRegistry } from './registry';
import { Scheduler } from './scheduler';
import { workflowCollections } from './schemas';
import { Sweeper } from './sweeper';
import { DEFAULT_CAPABILITY_QUEUES, WorkflowWorkerHost, type WorkerHostOptions } from './worker-host';

export interface WorkflowRuntimeDeps {
  db: Db;
  transport: QueueTransport;
  artifacts: ArtifactStore;
  logger: Logger;
  capabilities: AnyCapability[];
  services?: ServiceRegistry;
  clock?: Clock;
  metrics?: MetricsRegistry;
  leaseMs?: number;
  dispatcher?: Dispatcher;
  staleDispatchMs?: number;
}

export interface WorkflowRuntime {
  registry: CapabilityRegistry;
  catalog: WorkflowCatalog;
  engine: WorkflowEngine;
  scheduler: Scheduler;
  sweeper: Sweeper;
  queries: WorkflowQueries;
  services: ServiceRegistry;
  dispatcher: Dispatcher;
  registerWorkflows(specs: WorkflowSpec[]): Promise<void>;
  createWorkerHost(opts: Partial<WorkerHostOptions> & { workerId: string }): WorkflowWorkerHost;
}

/** Assemble the generic runtime. Domain packages contribute capabilities, services and workflows. */
export function createWorkflowRuntime(deps: WorkflowRuntimeDeps): WorkflowRuntime {
  const clock = deps.clock ?? systemClock;
  const registry = new CapabilityRegistry().register(forEachCapability).registerAll(deps.capabilities);
  const services = deps.services ?? new ServiceRegistry();
  const catalog = new WorkflowCatalog(deps.db, registry, clock);
  const dispatcher = deps.dispatcher ?? new BullMqDispatcher(deps.transport);
  const engine = new WorkflowEngine({
    db: deps.db,
    registry,
    catalog,
    artifacts: deps.artifacts,
    dispatcher,
    logger: deps.logger,
    services,
    clock,
    metrics: deps.metrics,
    leaseMs: deps.leaseMs,
  });
  const scheduler = new Scheduler(deps.db, engine, deps.logger, clock);
  const sweeper = new Sweeper(
    engine,
    dispatcher,
    deps.logger,
    { staleDispatchMs: deps.staleDispatchMs ?? 60_000 },
    clock,
  );
  const queries = new WorkflowQueries(engine);
  return {
    registry,
    catalog,
    engine,
    scheduler,
    sweeper,
    queries,
    services,
    dispatcher,
    async registerWorkflows(specs) {
      for (const s of specs) await catalog.register(s);
    },
    createWorkerHost(opts) {
      return new WorkflowWorkerHost(engine, deps.transport, scheduler, sweeper, deps.logger, {
        queues: DEFAULT_CAPABILITY_QUEUES,
        concurrency: 8,
        schedulerEnabled: true,
        schedulerIntervalMs: 5_000,
        sweeperIntervalMs: 15_000,
        leaseMs: deps.leaseMs ?? 60_000,
        ...opts,
      });
    },
  };
}

export async function ensureWorkflowCollections(db: Db): Promise<void> {
  await ensureCollections(db, [...workflowCollections, artifactsCollection] as never);
}
