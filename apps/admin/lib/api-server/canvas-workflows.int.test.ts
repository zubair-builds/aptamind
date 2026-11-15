import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, startApiHarness } from './market-test-harness';

/**
 * Canvas-generated WorkflowSpecs are registered through POST /api/workflows.
 * The route validates with the real WorkflowSpec schema and calls catalog.register (idempotent).
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await startApiHarness('canvas-workflows');
});

afterAll(async () => {
  await h?.close();
});

const validSpec = {
  key: 'canvas.test.workflow',
  title: 'Canvas test workflow',
  description: 'Registered from the visual canvas',
  nodes: [
    {
      id: 'trigger',
      title: 'Manual trigger',
      capability: { type: 'core.manual_trigger', version: 1 },
      config: {},
      input: {},
    },
  ],
  edges: [],
};

describe('POST /api/workflows (canvas registration)', () => {
  it('rejects an invalid spec', async () => {
    const res = await h.post('/api/workflows', { key: 'bad', title: 'Bad' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('registers a valid spec', async () => {
    const res = await h.post('/api/workflows', validSpec);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      key: 'canvas.test.workflow',
      created: true,
    });
    expect((res.body as { version: number }).version).toBeGreaterThan(0);
  });

  it('returns the same result when the same spec is registered twice', async () => {
    const first = await h.post('/api/workflows', validSpec);
    const second = await h.post('/api/workflows', validSpec);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect((second.body as { created: boolean }).created).toBe(false);
  });
});
