import type { WorkflowVersionDoc } from './schemas';
import { isTerminalNode, type NodeState } from './state-machine';

/**
 * Graph/dependency evaluation (pure). Given a workflow version and the current state of its
 * node runs, decides which nodes become runnable or skipped and what the run's aggregate
 * state is. No I/O: persistence and dispatch are the orchestrator's job.
 *
 * Semantics: a node is decided once every predecessor is terminal. It runs if at least one
 * incoming edge is *active* — its source COMPLETED and, for conditional edges, the source's
 * `output.branch` equals `when.branch` — otherwise it is SKIPPED (and skipping propagates).
 */

export interface NodeSnapshot {
  state: NodeState;
  /** `output.branch` of a completed node (for conditional edges). */
  branch?: unknown;
}

export type Snapshots = ReadonlyMap<string, NodeSnapshot>;

export interface NodeDecision {
  nodeId: string;
  action: 'run' | 'skip';
}

export const ACTIVE_NODE_STATES: readonly NodeState[] = [
  'QUEUED',
  'RUNNING',
  'RETRY_SCHEDULED',
  'FANNING_OUT',
];

type Graph = Pick<WorkflowVersionDoc, 'nodes' | 'edges'>;

export function incomingEdges(graph: Graph): Map<string, Graph['edges']> {
  const incoming = new Map<string, Graph['edges']>();
  for (const e of graph.edges) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
  return incoming;
}

/**
 * Nodes that can be decided now, in version order, including skip propagation (a skipped
 * node can make its successors decidable within the same evaluation).
 */
export function planNodeDecisions(graph: Graph, snapshots: Snapshots): NodeDecision[] {
  const incoming = incomingEdges(graph);
  const known = new Map(snapshots);
  const decisions: NodeDecision[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (known.has(node.id)) continue;
      const preds = incoming.get(node.id) ?? [];
      let action: NodeDecision['action'] | null = 'run';
      if (preds.length) {
        if (
          preds.some((e) => !known.has(e.from) || !isTerminalNode((known.get(e.from) as NodeSnapshot).state))
        ) {
          action = null;
        } else {
          const active = preds.some((e) => {
            const p = known.get(e.from) as NodeSnapshot;
            if (p.state !== 'COMPLETED') return false;
            return !e.when || p.branch === e.when.branch;
          });
          action = active ? 'run' : 'skip';
        }
      }
      if (!action) continue;
      decisions.push({ nodeId: node.id, action });
      // Only skips are terminal immediately; a run decision's node is QUEUED.
      known.set(node.id, { state: action === 'run' ? 'QUEUED' : 'SKIPPED' });
      changed = true;
    }
  }
  return decisions;
}

export type RunOutcome = 'failed' | 'completed' | 'waiting' | 'active';

/** Aggregate run outcome from node states (after planning). */
export function evaluateRunOutcome(graph: Graph, snapshots: Snapshots): RunOutcome {
  const states = [...snapshots.values()].map((s) => s.state);
  if (states.includes('FAILED')) return 'failed';
  if (
    graph.nodes.every(
      (n) => snapshots.has(n.id) && isTerminalNode((snapshots.get(n.id) as NodeSnapshot).state),
    )
  ) {
    return 'completed';
  }
  if (!states.some((s) => ACTIVE_NODE_STATES.includes(s)) && states.includes('WAITING')) return 'waiting';
  return 'active';
}

/** The node whose output becomes the run output: explicit `outputNode`, else the single sink. */
export function resolveOutputNodeId(graph: Graph & { outputNode?: string }): string | undefined {
  if (graph.outputNode) return graph.outputNode;
  const sources = new Set(graph.edges.map((e) => e.from));
  const sinks = graph.nodes.filter((n) => !sources.has(n.id));
  return sinks.length === 1 ? sinks[0]?.id : undefined;
}
