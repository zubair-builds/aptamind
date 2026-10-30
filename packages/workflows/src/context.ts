import type { ArtifactContext } from '@aptamind/contracts';
import type { Clock, JsonObject } from '@aptamind/contracts';
import type { Logger } from '@aptamind/observability';
import type { ArtifactStore } from '@aptamind/storage';
import {
  type CapabilityContext,
  isRecordSet,
  type NodeLogger,
  type RecordAccess,
  type RecordSet,
  type RecordsInput,
  type ServiceRegistry,
  SUSPEND,
  type Suspend,
  type WaitSpec,
} from '@aptamind/workflow-sdk';
import type { SubworkflowInvoker } from './ports';
import type { NodeRunDoc, WorkflowRunDoc } from './schemas';

export function createRecordAccess(
  artifacts: ArtifactStore,
  context: Partial<ArtifactContext>,
): RecordAccess {
  return {
    async write(records, labels = {}) {
      const lines: string[] = [];
      let count = 0;
      for await (const r of records as AsyncIterable<unknown>) {
        lines.push(JSON.stringify(r));
        count += 1;
      }
      const ref = await artifacts.put(lines.join('\n'), 'application/x-ndjson', {
        ...context,
        labels: { ...(context.labels ?? {}), ...labels, kind: 'recordset' },
      });
      const rs: RecordSet = { kind: 'recordset', format: 'jsonl', artifact: ref, count };
      return rs;
    },
    async *read(input: RecordsInput) {
      if (Array.isArray(input)) {
        yield* input;
        return;
      }
      if (!isRecordSet(input)) throw new Error('Expected an array or a record set');
      const text = await artifacts.readText(input.artifact);
      let start = 0;
      while (start < text.length) {
        let end = text.indexOf('\n', start);
        if (end === -1) end = text.length;
        const line = text.slice(start, end);
        if (line.trim()) yield JSON.parse(line);
        start = end + 1;
      }
    },
  };
}

/** What a capability may reach: services, artifacts and child workflows — never the engine. */
export interface CapabilityEnvironment {
  services: ServiceRegistry;
  artifacts: ArtifactStore;
  subworkflows: SubworkflowInvoker;
}

export interface BuildContextArgs {
  env: CapabilityEnvironment;
  run: WorkflowRunDoc;
  nodeRun: NodeRunDoc;
  attempt: number;
  idempotencyKey: string;
  signal: AbortSignal;
  clock: Clock;
  logger: Logger;
  logBuffer: NodeRunDoc['logs'];
  heartbeat: () => Promise<void>;
  resume?: JsonObject;
  itemIndex?: number;
}

export function buildCapabilityContext(args: BuildContextArgs): CapabilityContext {
  const { env, run, nodeRun } = args;
  const child = args.logger.child({
    capability: `${nodeRun.capability.type}@${nodeRun.capability.version}`,
    attempt: args.attempt,
    itemIndex: args.itemIndex,
  });
  const push = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => {
    child[level](data ?? {}, msg);
    if (level !== 'debug' && args.logBuffer.length < 500) {
      args.logBuffer.push({ at: args.clock.now(), level, msg, data: data ? truncateData(data) : undefined });
    }
  };
  const log: NodeLogger = {
    debug: (m, d) => push('debug', m, d),
    info: (m, d) => push('info', m, d),
    warn: (m, d) => push('warn', m, d),
    error: (m, d) => push('error', m, d),
  };
  const artifactContext = { runId: run._id, nodeRunId: nodeRun._id, workflowKey: run.workflowKey };
  const labelsFor = (labels: Record<string, string> = {}) => ({
    ...artifactContext,
    labels: { ...correlationLabels(run.labels), ...labels },
  });
  return {
    runId: run._id,
    rootRunId: run.rootRunId,
    nodeRunId: nodeRun._id,
    nodeId: nodeRun.nodeId,
    workflowKey: run.workflowKey,
    workflowVersion: run.workflowVersion,
    attempt: args.attempt,
    idempotencyKey: args.idempotencyKey,
    labels: run.labels,
    signal: args.signal,
    clock: args.clock,
    log,
    services: env.services,
    resume: args.resume,
    artifacts: {
      put: (body, mimeType, labels) => env.artifacts.put(body, mimeType, labelsFor(labels)),
      putJson: (value, labels) => env.artifacts.putJson(value, labelsFor(labels)),
      readBytes: (ref) => env.artifacts.readBytes(ref),
      readText: (ref) => env.artifacts.readText(ref),
      readJson: (ref) => env.artifacts.readJson(ref),
    },
    records: createRecordAccess(env.artifacts, labelsFor()),
    heartbeat: args.heartbeat,
    suspend(wait: WaitSpec): Suspend {
      return { [SUSPEND]: true, wait };
    },
    runSubworkflow: (req) =>
      env.subworkflows.run(
        { run, nodeRunId: nodeRun._id, itemIndex: args.itemIndex },
        req,
        `inline:${nodeRun._id}`,
        args.signal,
      ),
  };
}

/**
 * Domain-neutral correlation: every `*Id` label on a run (e.g. an owning entity id set by
 * the domain that started it) is attached to log lines and artifact labels. The runtime
 * never names domain concepts itself.
 */
export function correlationLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) if (/Id$/.test(k) && v) out[k] = v;
  return out;
}

function truncateData(data: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(data);
  if (json.length <= 2048) return data;
  return { truncated: true, preview: json.slice(0, 2048) };
}
