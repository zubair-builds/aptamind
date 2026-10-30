import type { WorkflowEdge } from './types';

/**
 * Stable topological order (Kahn's algorithm): among ready nodes, declaration order wins.
 * Nodes on a cycle (should never happen — the engine validates DAGs) are appended at the end.
 */
export function topoOrder<T>(nodes: T[], idOf: (n: T) => string, edges: WorkflowEdge[]): T[] {
  const ids = nodes.map(idOf);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!indeg.has(e.to) || !out.has(e.from)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    out.get(e.from)?.push(e.to);
  }
  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < ids.length) {
    const next = ids.find((id) => !done.has(id) && (indeg.get(id) ?? 0) === 0);
    if (!next) break;
    done.add(next);
    order.push(next);
    for (const to of out.get(next) ?? []) indeg.set(to, (indeg.get(to) ?? 0) - 1);
  }
  for (const id of ids) if (!done.has(id)) order.push(id);
  const byId = new Map(nodes.map((n) => [idOf(n), n]));
  return order.map((id) => byId.get(id)).filter((n): n is T => n !== undefined);
}

export function upstreamOf(nodeId: string, edges: WorkflowEdge[]): WorkflowEdge[] {
  return edges.filter((e) => e.to === nodeId);
}

export function downstreamOf(nodeId: string, edges: WorkflowEdge[]): WorkflowEdge[] {
  return edges.filter((e) => e.from === nodeId);
}
