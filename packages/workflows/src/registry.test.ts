import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCapability, workflowSpecSchema, type WorkflowSpec } from '@aptamind/workflow-sdk';
import { forEachCapability } from './control';
import { CapabilityRegistry, validateWith, validateWorkflowSpec, WorkflowValidationError } from './registry';
import { resolveTemplate } from './refs';

const echo = defineCapability({
  type: 'test.echo',
  version: 1,
  title: 'Echo',
  description: '',
  category: 'transform',
  inputSchema: z.object({ value: z.unknown() }),
  outputSchema: z.object({ value: z.unknown() }),
  configSchema: z.object({ prefix: z.string().default('') }),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(_ctx, input) {
    return { value: input.value };
  },
});

function registry() {
  return new CapabilityRegistry().register(echo).register(forEachCapability);
}

function validate(spec: WorkflowSpec) {
  validateWorkflowSpec(workflowSpecSchema.parse(spec), registry());
}

describe('capability registry & workflow validation', () => {
  it('rejects duplicate registration of the same type@version with different behaviour', () => {
    const r = registry();
    expect(() => r.register({ ...echo })).toThrow(/already registered/);
  });

  it('rejects unknown capabilities and invalid config before execution', () => {
    expect(() =>
      validate({
        key: 'wf.bad',
        title: 'x',
        nodes: [{ id: 'a', capability: { type: 'test.nope', version: 1 } }],
      }),
    ).toThrow(WorkflowValidationError);
    expect(() =>
      validate({
        key: 'wf.bad',
        title: 'x',
        nodes: [{ id: 'a', capability: { type: 'test.echo', version: 1 }, config: { prefix: 3 } }],
      }),
    ).toThrow(/config prefix/);
  });

  it('rejects cycles, unknown edges and non-upstream refs', () => {
    const nodes = [
      { id: 'a', capability: { type: 'test.echo', version: 1 } },
      { id: 'b', capability: { type: 'test.echo', version: 1 } },
    ];
    expect(() =>
      validate({
        key: 'wf.cyc',
        title: 'x',
        nodes,
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      }),
    ).toThrow(/cycle/);
    expect(() => validate({ key: 'wf.edge', title: 'x', nodes, edges: [{ from: 'a', to: 'zz' }] })).toThrow(
      /unknown node/,
    );
    expect(() =>
      validate({
        key: 'wf.ref',
        title: 'x',
        nodes: [nodes[0]!, { ...nodes[1]!, input: { value: { $ref: 'nodes.a.output.value' } } }],
        edges: [],
      }),
    ).toThrow(/not upstream/);
    expect(() =>
      validate({
        key: 'wf.ref2',
        title: 'x',
        nodes: [{ ...nodes[0]!, input: { v: { $ref: 'process.env.SECRET' } } }],
      }),
    ).toThrow(/unsupported \$ref/);
  });

  it('validates for_each config shape', () => {
    expect(() =>
      validate({
        key: 'wf.fe',
        title: 'x',
        nodes: [{ id: 'fe', capability: { type: 'core.for_each', version: 1 }, config: { body: {} } }],
      }),
    ).toThrow(/exactly one of capability or workflow/);
  });

  it('reports schema violations as capability validation errors', () => {
    expect(() => validateWith(z.object({ a: z.number() }), { a: 'x' }, 'input', 'test.echo@1')).toThrow(
      /Invalid input/,
    );
  });
});

describe('input template resolution', () => {
  it('substitutes refs with defaults and no code evaluation', async () => {
    const scope = {
      run: { input: { url: 'https://x', nested: { n: 1 } }, labels: { sourceId: 'src_1' } },
      trigger: { kind: 'manual' },
      nodeOutput: async (id: string) => ({ id, items: [1, 2] }),
      item: { name: 'Acme' },
      itemIndex: 4,
    };
    const out = await resolveTemplate(
      {
        url: { $ref: 'run.input.url' },
        n: { $ref: 'run.input.nested.n' },
        src: { $ref: 'run.labels.sourceId' },
        first: { $ref: 'nodes.parse.output.items.0' },
        name: { $ref: 'item.name' },
        idx: { $ref: 'itemIndex' },
        missing: { $ref: 'run.input.nope', default: 'dflt' },
        literal: ['a', { k: 1 }],
      },
      scope,
    );
    expect(out).toEqual({
      url: 'https://x',
      n: 1,
      src: 'src_1',
      first: 1,
      name: 'Acme',
      idx: 4,
      missing: 'dflt',
      literal: ['a', { k: 1 }],
    });
  });
});

describe('capability idempotency contract (audit H-3)', () => {
  const base = { ...echo, type: 'test.contract' };
  const withExecution = (execution: Record<string, unknown>) => ({ ...base, execution }) as never;
  const reg = (execution: Record<string, unknown>) => () =>
    new CapabilityRegistry().register(withExecution(execution));

  it('rejects an ambiguous retryable side effect', () => {
    expect(reg({ retryable: true, sideEffects: true, idempotency: 'optional' })).toThrow(
      /idempotency must be one of/,
    );
    expect(reg({ retryable: true, sideEffects: true, idempotency: 'required' })).toThrow(
      /idempotency must be one of/,
    );
  });

  it('rejects side effects declared pure, and pure declared side-effecting', () => {
    expect(reg({ retryable: true, sideEffects: true, idempotency: 'pure' })).toThrow(/cannot be 'pure'/);
    expect(
      reg({ retryable: true, sideEffects: false, idempotency: 'key', idempotencyProof: 'keyed on ctx key' }),
    ).toThrow(/without side effects must declare idempotency 'pure'/);
  });

  it('requires a proof for key and natural strategies', () => {
    expect(reg({ retryable: true, sideEffects: true, idempotency: 'key' })).toThrow(
      /requires idempotencyProof/,
    );
    expect(
      reg({ retryable: true, sideEffects: true, idempotency: 'natural', idempotencyProof: ' ' }),
    ).toThrow(/requires idempotencyProof/);
  });

  it('requires no_retry capabilities to be non-retryable', () => {
    expect(reg({ retryable: true, sideEffects: true, idempotency: 'no_retry' })).toThrow(
      /requires retryable: false/,
    );
  });

  it('accepts every valid combination', () => {
    expect(reg({ retryable: false, sideEffects: false, idempotency: 'pure' })).not.toThrow();
    expect(
      reg({
        retryable: true,
        sideEffects: true,
        idempotency: 'key',
        idempotencyProof: 'upsert keyed on ctx key',
      }),
    ).not.toThrow();
    expect(
      reg({
        retryable: true,
        sideEffects: true,
        idempotency: 'natural',
        idempotencyProof: 'content-addressed writes',
      }),
    ).not.toThrow();
    expect(reg({ retryable: false, sideEffects: true, idempotency: 'no_retry' })).not.toThrow();
  });

  it('refuses a no_retry capability as a for_each body', () => {
    const unsafe = {
      ...echo,
      type: 'test.unsafe',
      execution: { retryable: false, sideEffects: true, idempotency: 'no_retry' },
    } as never;
    const r = registry().register(unsafe);
    expect(() =>
      validateWorkflowSpec(
        workflowSpecSchema.parse({
          key: 'test.fanout_unsafe',
          title: 'unsafe fan-out',
          nodes: [
            {
              id: 'each',
              capability: { type: 'core.for_each', version: 1 },
              config: { body: { capability: { type: 'test.unsafe', version: 1 }, input: {} } },
              input: { items: [] },
            },
          ],
          edges: [],
        }),
        r,
      ),
    ).toThrow(/no_retry' and cannot be fanned out/);
  });
});
