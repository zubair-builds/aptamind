import { describe, expect, it } from 'vitest';
import { evaluateRunOutcome, type NodeSnapshot, planNodeDecisions, resolveOutputNodeId } from './graph';

const n = (id: string) => ({ id }) as never;
const graph = (nodes: string[], edges: Array<[string, string, string?]>) => ({
  nodes: nodes.map(n),
  edges: edges.map(([from, to, branch]) => ({ from, to, ...(branch ? { when: { branch } } : {}) })),
});
const snaps = (entries: Record<string, NodeSnapshot['state'] | NodeSnapshot>) =>
  new Map(Object.entries(entries).map(([k, v]) => [k, typeof v === 'string' ? { state: v } : v]));

describe('graph evaluation', () => {
  const abc = graph(
    ['a', 'b', 'c'],
    [
      ['a', 'b'],
      ['b', 'c'],
    ],
  );

  it('starts entry nodes only', () => {
    expect(planNodeDecisions(abc, snaps({}))).toEqual([{ nodeId: 'a', action: 'run' }]);
  });

  it('never re-plans nodes that already have a node run (completed work is not redone)', () => {
    expect(planNodeDecisions(abc, snaps({ a: 'COMPLETED', b: 'COMPLETED' }))).toEqual([
      { nodeId: 'c', action: 'run' },
    ]);
    expect(planNodeDecisions(abc, snaps({ a: 'COMPLETED', b: 'RUNNING' }))).toEqual([]);
  });

  it('follows conditional edges and propagates skips', () => {
    const g = graph(
      ['if', 'yes', 'no', 'after_no'],
      [
        ['if', 'yes', 'true'],
        ['if', 'no', 'false'],
        ['no', 'after_no'],
      ],
    );
    const plan = planNodeDecisions(g, snaps({ if: { state: 'COMPLETED', branch: 'true' } }));
    expect(plan).toEqual([
      { nodeId: 'yes', action: 'run' },
      { nodeId: 'no', action: 'skip' },
      { nodeId: 'after_no', action: 'skip' },
    ]);
  });

  it('runs a join when at least one incoming edge is active', () => {
    const g = graph(
      ['a', 'b', 'j'],
      [
        ['a', 'j'],
        ['b', 'j'],
      ],
    );
    expect(planNodeDecisions(g, snaps({ a: 'COMPLETED', b: 'SKIPPED' }))).toEqual([
      { nodeId: 'j', action: 'run' },
    ]);
    expect(planNodeDecisions(g, snaps({ a: 'COMPLETED', b: 'QUEUED' }))).toEqual([]);
  });

  it('derives the run outcome', () => {
    expect(evaluateRunOutcome(abc, snaps({ a: 'COMPLETED', b: 'FAILED' }))).toBe('failed');
    expect(evaluateRunOutcome(abc, snaps({ a: 'COMPLETED', b: 'COMPLETED', c: 'SKIPPED' }))).toBe(
      'completed',
    );
    expect(evaluateRunOutcome(abc, snaps({ a: 'COMPLETED', b: 'WAITING' }))).toBe('waiting');
    expect(evaluateRunOutcome(abc, snaps({ a: 'COMPLETED', b: 'RETRY_SCHEDULED' }))).toBe('active');
  });

  it('selects the output node', () => {
    expect(resolveOutputNodeId(abc)).toBe('c');
    expect(resolveOutputNodeId({ ...graph(['a', 'b'], []), outputNode: 'a' })).toBe('a');
    expect(resolveOutputNodeId(graph(['a', 'b'], []))).toBeUndefined();
  });
});
