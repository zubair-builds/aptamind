import { z } from 'zod';
import {
  type AnyCapability,
  type CapabilityRef,
  capabilityKey,
  CapabilityValidationError,
  executionContractViolation,
  type ParsedWorkflowSpec,
} from '@aptamind/workflow-sdk';

/**
 * Registry of executable capabilities (generic primitives and domain capabilities alike).
 * The runtime contract is identical for both; adding a capability never changes the engine.
 */
export class CapabilityRegistry {
  private readonly byKey = new Map<string, AnyCapability>();

  register(def: AnyCapability): this {
    const key = capabilityKey(def);
    // The idempotency contract is part of the capability contract: an ambiguous retryable side
    // effect (or a missing proof of idempotence) never reaches the runtime.
    const violation = executionContractViolation(def.execution);
    if (violation) throw new Error(`Capability ${key}: invalid execution contract: ${violation}`);
    const existing = this.byKey.get(key);
    if (existing && existing !== def) {
      throw new Error(`Capability ${key} is already registered; bump the version for behavioural changes`);
    }
    this.byKey.set(key, def);
    return this;
  }

  registerAll(defs: AnyCapability[]): this {
    for (const d of defs) this.register(d);
    return this;
  }

  get(ref: CapabilityRef): AnyCapability {
    const def = this.byKey.get(capabilityKey(ref));
    if (!def) throw new Error(`Capability ${capabilityKey(ref)} is not registered`);
    return def;
  }

  has(ref: CapabilityRef): boolean {
    return this.byKey.has(capabilityKey(ref));
  }

  latest(type: string): AnyCapability | undefined {
    let best: AnyCapability | undefined;
    for (const def of this.byKey.values()) {
      if (def.type === type && (!best || def.version > best.version)) best = def;
    }
    return best;
  }

  list(): AnyCapability[] {
    return [...this.byKey.values()].sort((a, b) => capabilityKey(a).localeCompare(capabilityKey(b)));
  }

  /** Descriptor suitable for the API/admin (JSON Schemas of config/input/output). */
  describe(def: AnyCapability) {
    return {
      type: def.type,
      version: def.version,
      key: capabilityKey(def),
      title: def.title,
      description: def.description,
      category: def.category,
      execution: def.execution,
      configSchema: safeJsonSchema(def.configSchema),
      inputSchema: safeJsonSchema(def.inputSchema),
      outputSchema: safeJsonSchema(def.outputSchema),
    };
  }
}

function safeJsonSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
  } catch {
    return { description: 'schema not representable as JSON Schema' };
  }
}

export function validateWith<T>(
  schema: z.ZodType<T>,
  value: unknown,
  phase: 'config' | 'input' | 'output',
  cap: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CapabilityValidationError(
      phase,
      cap,
      parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return parsed.data;
}

export class WorkflowValidationError extends Error {
  readonly code = 'validation_failed';
  constructor(
    public readonly workflowKey: string,
    public readonly issues: string[],
  ) {
    super(`Workflow ${workflowKey} is invalid:\n  - ${issues.join('\n  - ')}`);
    this.name = 'WorkflowValidationError';
  }
}

/**
 * Static validation of a workflow spec against the registry. Invalid node configuration is
 * rejected here — before any run executes (FR-2).
 */
export function validateWorkflowSpec(spec: ParsedWorkflowSpec, registry: CapabilityRegistry): void {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const node of spec.nodes) {
    if (ids.has(node.id)) issues.push(`duplicate node id "${node.id}"`);
    ids.add(node.id);
    if (!registry.has(node.capability)) {
      issues.push(`node "${node.id}": capability ${capabilityKey(node.capability)} is not registered`);
      continue;
    }
    const def = registry.get(node.capability);
    const cfg = def.configSchema.safeParse(node.config ?? {});
    if (!cfg.success) {
      for (const i of cfg.error.issues.slice(0, 5)) {
        issues.push(`node "${node.id}" config ${i.path.join('.') || '(root)'}: ${i.message}`);
      }
    } else if (def.execution.mode === 'fanout') {
      // Items of a fan-out can be re-run after a chunk takeover: bodies must be re-executable.
      const body = (cfg.data as { body?: { capability?: { type: string; version: number } } }).body;
      if (body?.capability && registry.has(body.capability)) {
        if (registry.get(body.capability).execution.idempotency === 'no_retry') {
          issues.push(
            `node "${node.id}": for_each body ${capabilityKey(body.capability)} is 'no_retry' and cannot be fanned out`,
          );
        }
      }
    }
  }
  for (const e of spec.edges) {
    if (!ids.has(e.from)) issues.push(`edge references unknown node "${e.from}"`);
    if (!ids.has(e.to)) issues.push(`edge references unknown node "${e.to}"`);
    if (e.from === e.to) issues.push(`self-loop on "${e.from}"`);
  }
  if (spec.outputNode && !ids.has(spec.outputNode))
    issues.push(`outputNode "${spec.outputNode}" does not exist`);
  if (!issues.length && hasCycle(spec))
    issues.push('workflow graph contains a cycle (only DAGs are supported)');
  for (const node of spec.nodes) checkRefs(node.id, node.input, ids, spec, issues);
  if (issues.length) throw new WorkflowValidationError(spec.key, issues);
}

function hasCycle(spec: ParsedWorkflowSpec): boolean {
  const adj = new Map<string, string[]>();
  for (const e of spec.edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): boolean => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    for (const m of adj.get(n) ?? []) if (visit(m)) return true;
    state.set(n, 2);
    return false;
  };
  return spec.nodes.some((n) => visit(n.id));
}

/** `nodes.<id>` references must point at an upstream (ancestor) node. */
function checkRefs(
  nodeId: string,
  template: unknown,
  ids: Set<string>,
  spec: ParsedWorkflowSpec,
  issues: string[],
): void {
  const ancestors = ancestorsOf(nodeId, spec);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      const r = (v as { $ref?: unknown }).$ref;
      if (typeof r === 'string') {
        const m = /^nodes\.([^.]+)/.exec(r);
        if (m && m[1]) {
          if (!ids.has(m[1])) issues.push(`node "${nodeId}" references unknown node "${m[1]}"`);
          else if (!ancestors.has(m[1]))
            issues.push(`node "${nodeId}" references "${m[1]}" which is not upstream`);
        } else if (!/^(run\.input|run\.labels|trigger|item|itemIndex)(\.|$)/.test(r)) {
          issues.push(`node "${nodeId}" has unsupported $ref root "${r}"`);
        }
        return;
      }
      Object.values(v).forEach(walk);
    }
  };
  walk(template);
}

function ancestorsOf(nodeId: string, spec: ParsedWorkflowSpec): Set<string> {
  const preds = new Map<string, string[]>();
  for (const e of spec.edges) preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
  const out = new Set<string>();
  const stack = [...(preds.get(nodeId) ?? [])];
  while (stack.length) {
    const n = stack.pop() as string;
    if (out.has(n)) continue;
    out.add(n);
    stack.push(...(preds.get(n) ?? []));
  }
  return out;
}
