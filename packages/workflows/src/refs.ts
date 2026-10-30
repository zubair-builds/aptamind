/**
 * Input template resolution. Replaces `{ "$ref": "path", "default"?: v }` leaves with
 * values from the resolution scope. Pure data substitution — no code evaluation.
 */

export interface RefScope {
  run: { input: unknown; labels: Record<string, string> };
  trigger: unknown;
  /** Lazily loads the output of an upstream node (may read an offloaded artifact). */
  nodeOutput(nodeId: string): Promise<unknown>;
  item?: unknown;
  itemIndex?: number;
}

export class RefResolutionError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'RefResolutionError';
  }
}

function getPath(value: unknown, path: string[]): unknown {
  let cur = value;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

async function resolveRef(path: string, scope: RefScope): Promise<unknown> {
  const parts = path.split('.');
  const [root, ...rest] = parts;
  switch (root) {
    case 'run': {
      const [sub, ...tail] = rest;
      if (sub === 'input') return getPath(scope.run.input, tail);
      if (sub === 'labels') return getPath(scope.run.labels, tail);
      throw new RefResolutionError(`Unsupported ref ${path}`);
    }
    case 'trigger':
      return getPath(scope.trigger, rest);
    case 'nodes': {
      const [nodeId, sub, ...tail] = rest;
      if (!nodeId || sub !== 'output')
        throw new RefResolutionError(`Unsupported ref ${path}; expected nodes.<id>.output`);
      return getPath(await scope.nodeOutput(nodeId), tail);
    }
    case 'item':
      if (scope.item === undefined) throw new RefResolutionError(`Ref ${path} used outside a for-each body`);
      return getPath(scope.item, rest);
    case 'itemIndex':
      return scope.itemIndex;
    default:
      throw new RefResolutionError(`Unsupported ref root in ${path}`);
  }
}

export async function resolveTemplate(template: unknown, scope: RefScope): Promise<unknown> {
  if (Array.isArray(template)) return Promise.all(template.map((t) => resolveTemplate(t, scope)));
  if (template && typeof template === 'object') {
    const obj = template as Record<string, unknown>;
    if (typeof obj.$ref === 'string' && Object.keys(obj).every((k) => k === '$ref' || k === 'default')) {
      const v = await resolveRef(obj.$ref, scope);
      return v === undefined ? obj.default : v;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const resolved = await resolveTemplate(v, scope);
      if (resolved !== undefined) out[k] = resolved;
    }
    return out;
  }
  return template;
}
