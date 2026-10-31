import { describe, expect, it } from 'vitest';
import { NodeSkippedError } from './outputs';
import { resolveTemplate, type RefScope } from './refs';

const scope = (outputs: Record<string, unknown>): RefScope => ({
  run: { input: {}, labels: {} },
  trigger: null,
  async nodeOutput(id) {
    if (id === 'skipped') throw new NodeSkippedError(id);
    if (!(id in outputs)) throw new Error(`missing ${id}`);
    return outputs[id];
  },
});

describe('resolveTemplate: skipped nodes (join after a branch)', () => {
  it('resolves a skipped node to the explicit default', async () => {
    expect(await resolveTemplate({ a: { $ref: 'nodes.skipped.output', default: null } }, scope({}))).toEqual({
      a: null,
    });
  });
  it('fails without a default', async () => {
    await expect(resolveTemplate({ $ref: 'nodes.skipped.output' }, scope({}))).rejects.toBeInstanceOf(
      NodeSkippedError,
    );
  });
  it('does not swallow other failures behind a default', async () => {
    await expect(resolveTemplate({ $ref: 'nodes.other.output', default: 1 }, scope({}))).rejects.toThrow(
      'missing other',
    );
  });
});
