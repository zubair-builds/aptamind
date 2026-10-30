import { describe, expect, it } from 'vitest';
import {
  assertNodeTransition,
  assertRunTransition,
  canTransitionNode,
  canTransitionRun,
  IllegalTransitionError,
  isTerminalNode,
  nodeStatesAllowing,
} from './state-machine';
import { computeBackoffMs } from './retry-policy';

describe('workflow state machines', () => {
  it('allows the happy path for nodes', () => {
    expect(() => {
      assertNodeTransition('QUEUED', 'RUNNING');
      assertNodeTransition('RUNNING', 'COMPLETED');
    }).not.toThrow();
  });

  it('supports retry, wait/resume, fan-out and operator retry paths', () => {
    expect(canTransitionNode('RUNNING', 'RETRY_SCHEDULED')).toBe(true);
    expect(canTransitionNode('RETRY_SCHEDULED', 'RUNNING')).toBe(true);
    expect(canTransitionNode('RUNNING', 'WAITING')).toBe(true);
    expect(canTransitionNode('WAITING', 'QUEUED')).toBe(true);
    expect(canTransitionNode('RUNNING', 'FANNING_OUT')).toBe(true);
    expect(canTransitionNode('FANNING_OUT', 'COMPLETED')).toBe(true);
    expect(canTransitionNode('FAILED', 'QUEUED')).toBe(true);
    expect(canTransitionNode('RUNNING', 'RUNNING')).toBe(true); // lease takeover
  });

  it('rejects illegal node transitions', () => {
    expect(() => assertNodeTransition('COMPLETED', 'RUNNING')).toThrow(IllegalTransitionError);
    expect(() => assertNodeTransition('SKIPPED', 'QUEUED')).toThrow(IllegalTransitionError);
    expect(() => assertNodeTransition('QUEUED', 'COMPLETED')).toThrow(IllegalTransitionError);
    expect(() => assertNodeTransition('CANCELLED', 'QUEUED')).toThrow(IllegalTransitionError);
  });

  it('keeps terminal run states terminal except operator retry of FAILED', () => {
    expect(canTransitionRun('COMPLETED', 'RUNNING')).toBe(false);
    expect(canTransitionRun('CANCELLED', 'RUNNING')).toBe(false);
    expect(canTransitionRun('FAILED', 'RUNNING')).toBe(true);
    expect(() => assertRunTransition('CANCELLING', 'COMPLETED')).toThrow(IllegalTransitionError);
  });

  it('derives guard states for conditional updates', () => {
    expect(nodeStatesAllowing('COMPLETED').sort()).toEqual(['FANNING_OUT', 'RUNNING']);
    expect(isTerminalNode('SKIPPED')).toBe(true);
    expect(isTerminalNode('WAITING')).toBe(false);
  });

  it('computes bounded exponential backoff', () => {
    expect(computeBackoffMs(1, 1000, 10_000)).toBe(1000);
    expect(computeBackoffMs(2, 1000, 10_000)).toBe(2000);
    expect(computeBackoffMs(3, 1000, 10_000)).toBe(4000);
    expect(computeBackoffMs(10, 1000, 10_000)).toBe(10_000);
  });
});
