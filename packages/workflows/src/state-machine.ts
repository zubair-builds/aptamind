/**
 * Explicit state machines for workflow runs and node runs. Every persisted transition
 * goes through `assert*Transition`, so illegal transitions fail loudly in tests.
 */

export const RUN_STATES = [
  'PENDING',
  'RUNNING',
  'WAITING',
  'CANCELLING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES: readonly RunState[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  PENDING: ['RUNNING', 'CANCELLING', 'CANCELLED', 'FAILED'],
  RUNNING: ['WAITING', 'CANCELLING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  WAITING: ['RUNNING', 'CANCELLING', 'CANCELLED', 'FAILED', 'COMPLETED'],
  CANCELLING: ['CANCELLED'],
  COMPLETED: [],
  // An operator may retry a failed step, which re-opens the run.
  FAILED: ['RUNNING'],
  CANCELLED: [],
};

export const NODE_STATES = [
  'QUEUED',
  'RUNNING',
  'FANNING_OUT',
  'RETRY_SCHEDULED',
  'WAITING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
] as const;
export type NodeState = (typeof NODE_STATES)[number];

export const TERMINAL_NODE_STATES: readonly NodeState[] = ['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED'];

const NODE_TRANSITIONS: Record<NodeState, readonly NodeState[]> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  // RUNNING -> RUNNING happens when an expired lease is taken over by another worker.
  RUNNING: ['RUNNING', 'COMPLETED', 'FAILED', 'RETRY_SCHEDULED', 'WAITING', 'FANNING_OUT', 'CANCELLED'],
  FANNING_OUT: ['COMPLETED', 'FAILED', 'CANCELLED'],
  RETRY_SCHEDULED: ['RUNNING', 'QUEUED', 'CANCELLED'],
  WAITING: ['QUEUED', 'CANCELLED', 'FAILED'],
  COMPLETED: [],
  // Operator retry of a failed, safely re-runnable step.
  FAILED: ['QUEUED'],
  SKIPPED: [],
  CANCELLED: [],
};

export class IllegalTransitionError extends Error {
  constructor(kind: 'run' | 'node', from: string, to: string) {
    super(`Illegal ${kind} transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransitionRun(from, to)) throw new IllegalTransitionError('run', from, to);
}

export function canTransitionNode(from: NodeState, to: NodeState): boolean {
  return NODE_TRANSITIONS[from].includes(to);
}

export function assertNodeTransition(from: NodeState, to: NodeState): void {
  if (!canTransitionNode(from, to)) throw new IllegalTransitionError('node', from, to);
}

/** States from which a node transition to `to` is legal — used as Mongo update guards. */
export function nodeStatesAllowing(to: NodeState): NodeState[] {
  return NODE_STATES.filter((s) => NODE_TRANSITIONS[s].includes(to));
}

export function runStatesAllowing(to: RunState): RunState[] {
  return RUN_STATES.filter((s) => RUN_TRANSITIONS[s].includes(to));
}

export function isTerminalNode(state: NodeState): boolean {
  return TERMINAL_NODE_STATES.includes(state);
}

export function isTerminalRun(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}
