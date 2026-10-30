import type { Filter } from 'mongodb';
import { NotFoundError, type Page } from '@aptamind/contracts';
import type { WorkflowEngine } from './engine';
import type { NodeRunDoc, WorkflowRunDoc } from './schemas';

export interface ListRunsQuery {
  workflowKey?: string;
  state?: string;
  /** Exact-match run labels (set by whoever started the run; meaning belongs to them). */
  labels?: Record<string, string>;
  parentRunId?: string;
  topLevelOnly?: boolean;
  limit: number;
  offset: number;
}

/** Read models for the API/admin. */
export class WorkflowQueries {
  constructor(private readonly engine: WorkflowEngine) {}

  async listRuns(q: ListRunsQuery): Promise<Page<WorkflowRunDoc>> {
    const filter: Filter<WorkflowRunDoc> = {};
    if (q.workflowKey) filter.workflowKey = q.workflowKey;
    if (q.state) filter.state = q.state as WorkflowRunDoc['state'];
    for (const [k, v] of Object.entries(q.labels ?? {}))
      (filter as Record<string, unknown>)[`labels.${k}`] = v;
    if (q.parentRunId) filter['parent.runId'] = q.parentRunId;
    else if (q.topLevelOnly) filter.depth = 0;
    const [items, total] = await Promise.all([
      this.engine.runs
        .find(filter, { projection: { input: 0, output: 0 } })
        .sort({ createdAt: -1 })
        .skip(q.offset)
        .limit(q.limit)
        .toArray(),
      this.engine.runs.countDocuments(filter),
    ]);
    return { items, total, limit: q.limit, offset: q.offset };
  }

  async getRunDetail(runId: string) {
    const run = await this.engine.runs.findOne({ _id: runId });
    if (!run) throw new NotFoundError('WorkflowRun', runId);
    const version = await this.engine.catalog.getVersionById(run.versionId);
    const nodeRuns = await this.engine.nodeRuns.find({ runId }, { projection: { logs: 0 } }).toArray();
    const byNode = new Map(nodeRuns.map((n) => [n.nodeId, n]));
    const fanoutStats = await this.engine.chunks
      .aggregate<{ _id: { nodeRunId: string; state: string }; count: number }>([
        { $match: { runId } },
        { $group: { _id: { nodeRunId: '$nodeRunId', state: '$state' }, count: { $sum: 1 } } },
      ])
      .toArray();
    const childCounts = await this.engine.runs
      .aggregate<{ _id: string; count: number }>([
        { $match: { 'parent.runId': runId } },
        { $group: { _id: '$state', count: { $sum: 1 } } },
      ])
      .toArray();
    const artifacts = await this.engine.artifacts.listByRun(runId, 50);
    return {
      run,
      version: { id: version._id, version: version.version, title: version.title, edges: version.edges },
      nodes: version.nodes.map((n) => ({
        nodeId: n.id,
        title: n.title,
        capability: n.capability,
        queue: n.queue,
        retry: n.retry,
        timeoutMs: n.timeoutMs,
        config: n.config,
        nodeRun: summarizeNodeRun(byNode.get(n.id)),
        chunkStates: Object.fromEntries(
          fanoutStats
            .filter((s) => s._id.nodeRunId === byNode.get(n.id)?._id)
            .map((s) => [s._id.state, s.count]),
        ),
      })),
      children: Object.fromEntries(childCounts.map((c) => [c._id, c.count])),
      artifacts,
    };
  }

  async getNodeRun(nodeRunId: string): Promise<NodeRunDoc> {
    const nr = await this.engine.nodeRuns.findOne({ _id: nodeRunId });
    if (!nr) throw new NotFoundError('NodeRun', nodeRunId);
    return nr;
  }

  async listChunks(nodeRunId: string, limit = 50, offset = 0) {
    const [items, total] = await Promise.all([
      this.engine.chunks
        .find({ nodeRunId }, { projection: { items: 0 } })
        .sort({ index: 1 })
        .skip(offset)
        .limit(limit)
        .toArray(),
      this.engine.chunks.countDocuments({ nodeRunId }),
    ]);
    return { items, total, limit, offset };
  }

  async stats(since: Date) {
    const [runStates, nodeFailures, waiting, retrying, oldestQueued] = await Promise.all([
      this.engine.runs
        .aggregate<{ _id: string; count: number }>([
          { $match: { createdAt: { $gte: since }, depth: 0 } },
          { $group: { _id: '$state', count: { $sum: 1 } } },
        ])
        .toArray(),
      this.engine.nodeRuns
        .aggregate<{ _id: string; count: number }>([
          { $match: { state: 'FAILED', updatedAt: { $gte: since } } },
          {
            $group: {
              _id: { $concat: ['$capability.type', '@', { $toString: '$capability.version' }] },
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
        ])
        .toArray(),
      this.engine.nodeRuns.countDocuments({ state: 'WAITING' }),
      this.engine.nodeRuns.countDocuments({ state: 'RETRY_SCHEDULED' }),
      this.engine.nodeRuns.find({ state: 'QUEUED' }).sort({ dispatchedAt: 1 }).limit(1).next(),
    ]);
    const activeRuns = await this.engine.runs.countDocuments({
      state: { $in: ['RUNNING', 'WAITING', 'CANCELLING'] },
    });
    const retryAgg = await this.engine.nodeRuns
      .aggregate<{ avg: number; total: number }>([
        { $match: { updatedAt: { $gte: since }, attempt: { $gt: 0 } } },
        { $group: { _id: null, avg: { $avg: '$attempt' }, total: { $sum: 1 } } },
      ])
      .next();
    return {
      since,
      runsByState: Object.fromEntries(runStates.map((r) => [r._id, r.count])),
      activeRuns,
      nodeFailuresByCapability: Object.fromEntries(nodeFailures.map((r) => [r._id, r.count])),
      waitingNodes: waiting,
      retryScheduledNodes: retrying,
      oldestQueuedAgeMs: oldestQueued?.dispatchedAt ? Date.now() - oldestQueued.dispatchedAt.getTime() : null,
      meanAttemptsPerNode: retryAgg?.avg ?? null,
    };
  }
}

function summarizeNodeRun(nr: NodeRunDoc | undefined) {
  if (!nr) return null;
  return {
    id: nr._id,
    state: nr.state,
    attempt: nr.attempt,
    maxAttempts: nr.maxAttempts,
    manualRetries: nr.manualRetries,
    attempts: nr.attempts,
    input: nr.input,
    inputTruncated: nr.inputTruncated,
    output: nr.output,
    outputRef: nr.outputRef,
    outputPreview: nr.outputPreview,
    error: nr.error,
    wait: nr.wait,
    fanout: nr.fanout,
    startedAt: nr.startedAt,
    finishedAt: nr.finishedAt,
    durationMs: nr.durationMs,
    skipReason: nr.skipReason,
  };
}
