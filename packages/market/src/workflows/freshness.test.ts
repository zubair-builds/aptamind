import { describe, expect, it } from 'vitest';
import { freshnessSweep, sweepRecordedEvidence } from '../workflow-nodes/jobs';
import { freshnessSweepWorkflow } from './index';

describe('freshness workflow (PR #11 re-verify #12 LOW-4)', () => {
  it('the recorded-evidence sweep is its own node, not behind the freshness sweep', () => {
    const node = freshnessSweepWorkflow.nodes.find((n) => n.id === 'evidence');
    expect(node?.capability).toEqual({ type: 'market.sweep_recorded_evidence', version: 1 });
    expect(freshnessSweepWorkflow.edges).toContainEqual({ from: 'trigger', to: 'evidence' });
  });

  it('each sweep has an explicit timeout that fits its time budget', () => {
    const budget = sweepRecordedEvidence.configSchema.parse({}).budgetMs;
    const timeout = sweepRecordedEvidence.execution.defaultTimeoutMs!;
    expect(timeout).toBeGreaterThan(budget);
    // The configurable budget can never exceed the timeout either.
    expect(() => sweepRecordedEvidence.configSchema.parse({ budgetMs: timeout })).toThrow();
    expect(freshnessSweep.execution.defaultTimeoutMs).toBeGreaterThanOrEqual(10 * 60_000);
  });
});
