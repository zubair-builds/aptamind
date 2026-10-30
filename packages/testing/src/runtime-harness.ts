import { DefaultAiGateway } from '@aptamind/ai';
import type { Clock } from '@aptamind/contracts';
import { SafeHttpClient } from '@aptamind/net';
import type { AnyCapability } from '@aptamind/workflow-sdk';
import {
  AI_GATEWAY,
  AI_TASKS,
  AiTaskRegistry,
  BROWSER,
  genericCapabilities,
  NET_CLIENT,
  UnavailableBrowserService,
} from '@aptamind/workflow-nodes';
import { createWorkflowRuntime, type Dispatcher, type WorkflowRuntime } from '@aptamind/workflows';
import { TEST_DB, testCapabilities } from './fixtures/test-capabilities';
import type { TestInfra } from './index';

export interface TestRuntimeOptions {
  capabilities?: AnyCapability[];
  leaseMs?: number;
  staleDispatchMs?: number;
  /** Override the transport (e.g. a recording or failing dispatcher). */
  dispatcher?: Dispatcher;
  /** Controllable clock (lease expiry, backoff) for deterministic interleaving tests. */
  clock?: Clock;
}

/** A workflow runtime wired to real infrastructure with generic + test capabilities. */
export function createTestRuntime(
  infra: TestInfra,
  opts: TestRuntimeOptions = {},
): WorkflowRuntime & { http: SafeHttpClient } {
  const runtime = createWorkflowRuntime({
    db: infra.db,
    transport: infra.transport,
    artifacts: infra.artifacts,
    logger: infra.logger,
    capabilities: [...genericCapabilities, ...testCapabilities, ...(opts.capabilities ?? [])],
    leaseMs: opts.leaseMs ?? 5_000,
    staleDispatchMs: opts.staleDispatchMs ?? 500,
    dispatcher: opts.dispatcher,
    clock: opts.clock,
  });
  const http = new SafeHttpClient({
    allowPrivateNetwork: true,
    userAgent: 'aptamind-test',
    defaultTimeoutMs: 5_000,
    maxResponseBytes: 10 * 1024 * 1024,
    perHostConcurrency: 8,
    perHostMinIntervalMs: 0,
  });
  runtime.services
    .register(TEST_DB, infra.db)
    .register(NET_CLIENT, http)
    .register(BROWSER, new UnavailableBrowserService())
    .register(AI_GATEWAY, new DefaultAiGateway(null))
    .register(AI_TASKS, new AiTaskRegistry());
  return Object.assign(runtime, { http });
}
