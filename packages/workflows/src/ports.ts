import type { SubworkflowRequest, SubworkflowResult } from '@aptamind/workflow-sdk';
import type { WorkflowRunDoc } from './schemas';
import type { NodeState } from './state-machine';
import type { StartRunRequest } from './triggers';

/**
 * The narrow interface runtime components use to call back into the orchestrator. Components
 * never hold the engine itself, only this port — which keeps their dependencies explicit and
 * lets them be tested with a stub.
 */
export interface RunDriver {
  startRun(req: StartRunRequest): Promise<WorkflowRunDoc>;
  /** Evaluate the graph after a node reached a new state; creates/dispatches ready nodes. */
  advanceRun(runId: string, opts: { dispatch: boolean }): Promise<string[]>;
  executeNodeRun(nodeRunId: string, workerId: string, opts?: { inline?: boolean }): Promise<NodeState | null>;
}

export interface SubworkflowParent {
  run: WorkflowRunDoc;
  nodeRunId: string;
  itemIndex?: number;
}

export interface SubworkflowInvoker {
  run(
    parent: SubworkflowParent,
    req: SubworkflowRequest,
    workerId: string,
    signal?: AbortSignal,
  ): Promise<SubworkflowResult>;
}
