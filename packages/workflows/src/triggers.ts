import { type JsonObject, newId } from '@aptamind/contracts';
import { capabilityKey } from '@aptamind/workflow-sdk';
import { SubworkflowDepthError } from './errors';
import {
  type Trigger,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowRunDoc,
  type WorkflowVersionDoc,
} from './schemas';

/** How a run is requested — by an operator/API, a schedule, a parent node, or a domain event. */
export interface StartRunRequest {
  workflowKey: string;
  version?: number;
  input?: JsonObject;
  trigger: Trigger;
  idempotencyKey?: string;
  labels?: Record<string, string>;
  parent?: { runId: string; nodeRunId: string; itemIndex?: number };
  /** `queued` dispatches nodes to workers; `inline` is used for child runs. */
  mode?: 'queued' | 'inline';
}

/**
 * Build the WorkflowRun document for a trigger (pure). The run is pinned to one immutable
 * workflow version and records the exact capability type@version of every node, so later
 * edits of the workflow or capability upgrades never change what a historical run meant.
 */
export function buildRunDocument(args: {
  version: WorkflowVersionDoc;
  req: StartRunRequest;
  parentRun: WorkflowRunDoc | null;
  maxDepth: number;
  now: Date;
  runId?: string;
}): WorkflowRunDoc {
  const { version, req, parentRun, now } = args;
  if (parentRun && parentRun.depth + 1 > args.maxDepth) throw new SubworkflowDepthError(args.maxDepth);
  const runId = args.runId ?? newId('run');
  return {
    _id: runId,
    workflowKey: version.workflowKey,
    workflowVersion: version.version,
    versionId: version._id,
    state: 'RUNNING',
    // Run input is JSON by contract (dates become ISO strings) so templates resolve identically on every attempt.
    input: normalizeJson(req.input ?? {}),
    trigger: req.trigger,
    idempotencyKey: req.idempotencyKey,
    parent: req.parent,
    rootRunId: parentRun?.rootRunId ?? runId,
    depth: parentRun ? parentRun.depth + 1 : 0,
    labels: { ...version.labels, ...(parentRun?.labels ?? {}), ...(req.labels ?? {}) },
    capabilityVersions: Object.fromEntries(version.nodes.map((n) => [n.id, capabilityKey(n.capability)])),
    failedNodeIds: [],
    startedAt: now,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeJson(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
