import { InvalidStateError, type JsonValue } from '@aptamind/contracts';
import type { ArtifactStore } from '@aptamind/storage';
import type { NodeRunDoc, WorkflowRunDoc } from './schemas';
import type { AttemptFence, NodeRunStore } from './stores/node-run-store';

export interface OutputLimits {
  /** Serialised outputs larger than this are stored as an artifact and referenced by `outputRef`. */
  maxInlineOutputBytes: number;
  /** Resolved inputs larger than this are recorded as a truncated preview only. */
  maxInlineInputBytes: number;
}

/**
 * Node input/output storage. Small JSON values live inline on the node run; large ones are
 * written once to the content-addressed artifact store and referenced by `ArtifactRef`
 * (sha256, size, mime type), so Mongo documents stay small and raw content is never copied
 * between nodes — downstream nodes resolve the reference when they read it.
 */
export class NodeOutputStore {
  constructor(
    private readonly nodeRuns: NodeRunStore,
    private readonly artifacts: ArtifactStore,
    private readonly limits: OutputLimits,
  ) {}

  async recordInput(fence: AttemptFence, input: unknown): Promise<void> {
    const json = JSON.stringify(input ?? null);
    if (json.length <= this.limits.maxInlineInputBytes) {
      await this.nodeRuns.recordInput(fence, input as JsonValue, false);
    } else {
      await this.nodeRuns.recordInput(fence, json.slice(0, 2048), true);
    }
  }

  async store(
    run: Pick<WorkflowRunDoc, '_id' | 'workflowKey'>,
    nodeRunId: string,
    output: unknown,
  ): Promise<Pick<NodeRunDoc, 'output' | 'outputRef' | 'outputPreview'>> {
    const json = JSON.stringify(output ?? null);
    if (json.length <= this.limits.maxInlineOutputBytes) return { output: JSON.parse(json) as JsonValue };
    const ref = await this.artifacts.put(json, 'application/json', {
      runId: run._id,
      nodeRunId,
      workflowKey: run.workflowKey,
      labels: { kind: 'node-output' },
    });
    return { outputRef: ref, outputPreview: json.slice(0, 2048) };
  }

  /** Output of a COMPLETED node (resolving its artifact reference), optionally memoised. */
  async load(runId: string, nodeId: string, cache?: Map<string, unknown>): Promise<unknown> {
    if (cache?.has(nodeId)) return cache.get(nodeId);
    const nr = await this.nodeRuns.findCompletedOutput(runId, nodeId);
    if (!nr || nr.state !== 'COMPLETED') {
      throw new InvalidStateError(
        `Output of node ${nodeId} is not available (state ${nr?.state ?? 'missing'})`,
      );
    }
    const value = nr.outputRef ? await this.artifacts.readJson(nr.outputRef) : nr.output;
    cache?.set(nodeId, value);
    return value;
  }

  /** A run's output (inline or by reference). */
  async runOutput(run: Pick<WorkflowRunDoc, 'output' | 'outputRef'>): Promise<unknown> {
    return run.outputRef ? this.artifacts.readJson(run.outputRef) : run.output;
  }
}
