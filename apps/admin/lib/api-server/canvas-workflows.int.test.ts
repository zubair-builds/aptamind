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

  it('rejects a second registration of an existing key (title-collision guard)', async () => {
    const second = await h.post('/api/workflows', validSpec);
    expect(second.status).toBe(409);
    expect((second.body as { error?: { message?: string } }).error?.message).toContain('already exists');
  });

  it('rejects a professional.* key', async () => {
    const res = await h.post('/api/workflows', {
      ...validSpec,
      key: 'professional.secret.workflow',
    });
    expect(res.status).toBe(403);
    expect((res.body as { error?: { message?: string } }).error?.message).toContain('reserved');
  });

  it('rejects an unknown step type', async () => {
    const res = await h.post('/api/workflows', {
      ...validSpec,
      key: 'canvas.unknown.step',
      nodes: [
        {
          id: 'bad',
          title: 'Unknown',
          capability: { type: 'core.does_not_exist', version: 1 },
          config: {},
          input: {},
        },
      ],
    });
    expect(res.status).toBe(400);
    expect((res.body as { error?: { message?: string } }).error?.message).toContain('core.does_not_exist@1');
  });
});
