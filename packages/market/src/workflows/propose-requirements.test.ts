import { describe, expect, it } from 'vitest';
import { proposeJobRequirements } from '../workflow-nodes/jobs';
import { jobProposeRequirements, marketWorkflows } from './index';

describe('market.job.propose_requirements workflow', () => {
  it('is registered once in marketWorkflows', () => {
    const matches = marketWorkflows.filter((w) => w.key === 'market.job.propose_requirements');
    expect(matches).toEqual([jobProposeRequirements]);
  });

  it('is manually triggered and runs only the AI proposal capability', () => {
    expect(jobProposeRequirements.nodes.map((n) => n.capability)).toEqual([
      { type: 'core.manual_trigger', version: 1 },
      { type: 'market.propose_job_requirements', version: 1 },
    ]);
    const step = jobProposeRequirements.nodes.find((n) => n.id === 'propose');
    expect(step?.input).toEqual({ jobId: { $ref: 'nodes.trigger.output.payload.jobId' } });
    expect(jobProposeRequirements.edges).toEqual([{ from: 'trigger', to: 'propose' }]);
    expect(jobProposeRequirements.outputNode).toBe('propose');
  });

  it('requires a jobId in the run input', () => {
    expect(jobProposeRequirements.inputSchema).toMatchObject({ required: ['jobId'] });
    expect(proposeJobRequirements.inputSchema.safeParse({ jobId: 'job_1' }).success).toBe(true);
    expect(proposeJobRequirements.inputSchema.safeParse({}).success).toBe(false);
    expect(proposeJobRequirements.inputSchema.safeParse({ jobId: 7 }).success).toBe(false);
  });

  it('the step is the AI capability on the ai queue', () => {
    expect(proposeJobRequirements.category).toBe('ai');
    expect(proposeJobRequirements.execution.queue).toBe('ai');
  });
});
