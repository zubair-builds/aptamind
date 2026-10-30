import { z } from 'zod';
import { artifactRefSchema, jsonObjectSchema, jsonValueSchema } from '@aptamind/contracts';
import { defineCollection } from '@aptamind/db';
import { edgeSpecSchema, nodeSpecSchema, retryPolicySchema } from '@aptamind/workflow-sdk';
import { NODE_STATES, RUN_STATES } from './state-machine';

export const WORKFLOW_SCHEMA_VERSION = 1;

const meta = {
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
};

const errorSchema = z.object({
  name: z.string(),
  message: z.string(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  stack: z.string().optional(),
});

// ---------------------------------------------------------------------------------------
// Definitions & immutable versions
// ---------------------------------------------------------------------------------------

export const workflowDefinitionDocSchema = z.object({
  _id: z.string(), // workflow key
  title: z.string(),
  description: z.string(),
  latestVersion: z.number().int().positive(),
  labels: z.record(z.string(), z.string()),
  archived: z.boolean().default(false),
  ...meta,
});
export type WorkflowDefinitionDoc = z.infer<typeof workflowDefinitionDocSchema>;

export const resolvedNodeSchema = nodeSpecSchema.extend({
  retry: retryPolicySchema,
  timeoutMs: z.number().int().positive(),
  queue: z.string(),
});
export type ResolvedNode = z.infer<typeof resolvedNodeSchema>;

export const workflowVersionDocSchema = z.object({
  _id: z.string(), // `${key}@${version}`
  workflowKey: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  nodes: z.array(resolvedNodeSchema),
  edges: z.array(edgeSpecSchema),
  inputSchema: jsonObjectSchema.optional(),
  outputNode: z.string().optional(),
  labels: z.record(z.string(), z.string()),
  /** Hash of the normalised spec: identical specs never create a new version. */
  contentHash: z.string(),
  ...meta,
});
export type WorkflowVersionDoc = z.infer<typeof workflowVersionDocSchema>;

export const workflowDefinitionsCollection = defineCollection<WorkflowDefinitionDoc>({
  name: 'workflow_definitions',
  description: 'Workflow identities; each points at its latest immutable version.',
  schema: workflowDefinitionDocSchema,
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  indexes: [],
});

export const workflowVersionsCollection = defineCollection<WorkflowVersionDoc>({
  name: 'workflow_versions',
  description: 'Immutable workflow versions (graph + exact capability versions).',
  schema: workflowVersionDocSchema,
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  indexes: [
    {
      key: { workflowKey: 1, version: -1 },
      options: { name: 'uniq_key_version', unique: true },
      rationale: 'One document per (workflow, version); ordered lookup of latest version.',
    },
    {
      key: { workflowKey: 1, contentHash: 1 },
      options: { name: 'by_key_hash' },
      rationale: 'Detect re-registration of an identical spec.',
    },
  ],
});

// ---------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------

export const triggerSchema = z.object({
  kind: z.enum(['manual', 'schedule', 'subworkflow', 'api', 'event']),
  actor: z.object({ kind: z.string(), id: z.string() }).optional(),
  scheduleId: z.string().optional(),
  scheduledFor: z.date().optional(),
  event: z.string().optional(),
  data: jsonObjectSchema.optional(),
});
export type Trigger = z.infer<typeof triggerSchema>;

export const workflowRunDocSchema = z.object({
  _id: z.string(),
  workflowKey: z.string(),
  workflowVersion: z.number().int(),
  versionId: z.string(),
  state: z.enum(RUN_STATES),
  input: jsonObjectSchema,
  trigger: triggerSchema,
  idempotencyKey: z.string().optional(),
  parent: z
    .object({ runId: z.string(), nodeRunId: z.string(), itemIndex: z.number().int().optional() })
    .optional(),
  rootRunId: z.string(),
  depth: z.number().int().min(0),
  labels: z.record(z.string(), z.string()),
  /** Exact capability version executed by each node (`type@version`). */
  capabilityVersions: z.record(z.string(), z.string()),
  output: jsonValueSchema.optional(),
  outputRef: artifactRefSchema.optional(),
  error: errorSchema.optional(),
  failedNodeIds: z.array(z.string()).default([]),
  cancelRequestedAt: z.date().optional(),
  startedAt: z.date().optional(),
  finishedAt: z.date().optional(),
  durationMs: z.number().optional(),
  ...meta,
});
export type WorkflowRunDoc = z.infer<typeof workflowRunDocSchema>;

export const workflowRunsCollection = defineCollection<WorkflowRunDoc>({
  name: 'workflow_runs',
  description: 'Durable workflow run state (source of truth; BullMQ is only transport).',
  schema: workflowRunDocSchema,
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  indexes: [
    {
      key: { idempotencyKey: 1 },
      options: {
        name: 'uniq_idempotency_key',
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      },
      rationale:
        'Duplicate trigger/schedule dispatch returns the existing run instead of creating a new one.',
    },
    {
      key: { workflowKey: 1, createdAt: -1 },
      options: { name: 'by_workflow_recent' },
      rationale: 'Run history per workflow.',
    },
    {
      key: { state: 1, updatedAt: 1 },
      options: { name: 'by_state_updated' },
      rationale: 'Sweeper/dashboards: find running/failed runs.',
    },
    {
      key: { 'parent.runId': 1 },
      options: { name: 'by_parent', sparse: true },
      rationale: 'Child/subworkflow lineage.',
    },
    { key: { createdAt: -1 }, options: { name: 'by_created' }, rationale: 'Global recent runs list.' },
  ],
});

// ---------------------------------------------------------------------------------------
// Node runs
// ---------------------------------------------------------------------------------------

export const attemptSchema = z.object({
  attempt: z.number().int().positive(),
  workerId: z.string(),
  startedAt: z.date(),
  finishedAt: z.date().optional(),
  durationMs: z.number().optional(),
  status: z.enum(['running', 'completed', 'failed', 'timed_out', 'lost', 'suspended', 'cancelled']),
  error: errorSchema.optional(),
});
export type AttemptRecord = z.infer<typeof attemptSchema>;

export const logEntrySchema = z.object({
  at: z.date(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  msg: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const fanoutStateSchema = z.object({
  totalItems: z.number().int(),
  totalChunks: z.number().int(),
  batchSize: z.number().int(),
  concurrency: z.number().int(),
  inFlight: z.number().int(),
  completedChunks: z.number().int(),
  succeededItems: z.number().int(),
  failedItems: z.number().int(),
  failurePolicy: z.enum(['continue', 'fail_fast']),
  maxFailureRatio: z.number().min(0).max(1),
  bodyCapability: z.string().optional(),
  bodyWorkflow: z.string().optional(),
  lastPumpAt: z.date().optional(),
});
export type FanoutState = z.infer<typeof fanoutStateSchema>;

export const nodeRunDocSchema = z.object({
  _id: z.string(),
  runId: z.string(),
  rootRunId: z.string(),
  workflowKey: z.string(),
  nodeId: z.string(),
  capability: z.object({ type: z.string(), version: z.number().int() }),
  state: z.enum(NODE_STATES),
  queue: z.string(),
  idempotencyKey: z.string(),
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  manualRetries: z.number().int().min(0),
  resumeCount: z.number().int().min(0).default(0),
  /** Extra attempts granted because a completed attempt's outcome could not be recorded. */
  ackRetries: z.number().int().min(0).optional(),
  attempts: z.array(attemptSchema),
  input: jsonValueSchema.optional(),
  inputTruncated: z.boolean().optional(),
  output: jsonValueSchema.optional(),
  outputRef: artifactRefSchema.optional(),
  outputPreview: z.string().optional(),
  error: errorSchema.optional(),
  wait: z
    .object({
      kind: z.string(),
      reason: z.string(),
      correlationKey: z.string().optional(),
      timeoutAt: z.date().optional(),
      data: jsonObjectSchema.optional(),
      since: z.date(),
    })
    .optional(),
  resumePayload: jsonObjectSchema.optional(),
  fanout: fanoutStateSchema.optional(),
  leaseOwner: z.string().optional(),
  leaseExpiresAt: z.date().optional(),
  nextAttemptAt: z.date().optional(),
  dispatchSeq: z.number().int().min(0),
  dispatchedAt: z.date().optional(),
  skipReason: z.string().optional(),
  logs: z.array(logEntrySchema),
  startedAt: z.date().optional(),
  finishedAt: z.date().optional(),
  durationMs: z.number().optional(),
  ...meta,
});
export type NodeRunDoc = z.infer<typeof nodeRunDocSchema>;

export const nodeRunsCollection = defineCollection<NodeRunDoc>({
  name: 'workflow_node_runs',
  description: 'Durable per-node execution state, attempts, logs and outputs.',
  schema: nodeRunDocSchema,
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  indexes: [
    {
      key: { runId: 1, nodeId: 1 },
      options: { name: 'uniq_run_node', unique: true },
      rationale: 'Exactly one node run per (run, node): concurrent run advancement is idempotent.',
    },
    {
      key: { state: 1, leaseExpiresAt: 1 },
      options: { name: 'by_state_lease' },
      rationale: 'Sweeper: running nodes whose lease expired (crashed worker).',
    },
    {
      key: { state: 1, nextAttemptAt: 1 },
      options: { name: 'by_state_next_attempt' },
      rationale: 'Sweeper: retries that are due.',
    },
    {
      key: { state: 1, dispatchedAt: 1 },
      options: { name: 'by_state_dispatched' },
      rationale: 'Sweeper: queued nodes whose transport job may have been lost (Redis restart).',
    },
    {
      key: { 'wait.correlationKey': 1 },
      options: { name: 'by_wait_correlation', sparse: true },
      rationale: 'Resume waiting nodes by correlation key (e.g. review item).',
    },
  ],
});

// ---------------------------------------------------------------------------------------
// Fan-out chunks
// ---------------------------------------------------------------------------------------

export const itemResultSchema = z.object({
  index: z.number().int(),
  status: z.enum(['succeeded', 'failed']),
  output: jsonValueSchema.optional(),
  error: errorSchema.optional(),
  attempts: z.number().int(),
  childRunId: z.string().optional(),
});
export type ItemResult = z.infer<typeof itemResultSchema>;

export const fanoutChunkDocSchema = z.object({
  _id: z.string(),
  runId: z.string(),
  nodeRunId: z.string(),
  index: z.number().int(),
  startIndex: z.number().int(),
  items: z.array(jsonValueSchema),
  state: z.enum(['PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED']),
  results: z.array(itemResultSchema),
  attempt: z.number().int(),
  leaseOwner: z.string().optional(),
  leaseExpiresAt: z.date().optional(),
  dispatchSeq: z.number().int(),
  dispatchedAt: z.date().optional(),
  startedAt: z.date().optional(),
  finishedAt: z.date().optional(),
  ...meta,
});
export type FanoutChunkDoc = z.infer<typeof fanoutChunkDocSchema>;

export const fanoutChunksCollection = defineCollection<FanoutChunkDoc>({
  name: 'workflow_fanout_chunks',
  description: 'Batches of for-each items; bounded-concurrency fan-out work units.',
  schema: fanoutChunkDocSchema,
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  indexes: [
    {
      key: { nodeRunId: 1, state: 1, index: 1 },
      options: { name: 'by_node_state_index' },
      rationale: 'Claim the next pending chunk in order; count progress.',
    },
    {
      key: { state: 1, leaseExpiresAt: 1 },
      options: { name: 'by_state_lease' },
      rationale: 'Sweeper: recover chunks from crashed workers.',
    },
    {
      key: { state: 1, dispatchedAt: 1 },
      options: { name: 'by_state_dispatched' },
      rationale: 'Sweeper: re-dispatch chunks whose transport job was lost.',
    },
  ],
});

// ---------------------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------------------

export const scheduleDocSchema = z.object({
  _id: z.string(),
  workflowKey: z.string(),
  /** Pin a version, or follow the latest version when omitted. */
  workflowVersion: z.number().int().optional(),
  cron: z.string().optional(),
  intervalMinutes: z.number().int().positive().optional(),
  timezone: z.string(),
  input: jsonObjectSchema,
  labels: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  /** Generic owner reference (e.g. `{ kind: 'source', id }`); meaning belongs to the owner. */
  owner: z.object({ kind: z.string(), id: z.string() }).optional(),
  nextFireAt: z.date().optional(),
  lastFiredAt: z.date().optional(),
  lastRunId: z.string().optional(),
  lastError: z.string().optional(),
  fireCount: z.number().int(),
  ...meta,
});
export type ScheduleDoc = z.infer<typeof scheduleDocSchema>;

export const schedulesCollection = defineCollection<ScheduleDoc>({
  name: 'workflow_schedules',
  description: 'Schedule triggers. Due-ness is evaluated from MongoDB, not Redis.',
  schema: scheduleDocSchema,
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  indexes: [
    {
      key: { enabled: 1, nextFireAt: 1 },
      options: { name: 'by_enabled_due' },
      rationale: 'Scheduler tick: find due schedules.',
    },
    {
      key: { 'owner.kind': 1, 'owner.id': 1 },
      options: {
        name: 'uniq_owner',
        unique: true,
        partialFilterExpression: { 'owner.id': { $type: 'string' } },
      },
      rationale: 'At most one schedule per owning entity (e.g. one per source).',
    },
  ],
});

export const workflowCollections = [
  workflowDefinitionsCollection,
  workflowVersionsCollection,
  workflowRunsCollection,
  nodeRunsCollection,
  fanoutChunksCollection,
  schedulesCollection,
];
