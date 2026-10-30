import type { ZodType } from 'zod';

interface Def {
  type: string;
  shape?: Record<string, ZodType>;
  element?: ZodType;
  innerType?: ZodType;
  options?: ZodType[];
  in?: ZodType;
  out?: ZodType;
  left?: ZodType;
  right?: ZodType;
  valueType?: ZodType;
  getter?: () => ZodType;
}

const def = (s: ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

/**
 * Every property path a Zod schema can produce (`roles[].value.organization.name`), found by
 * walking the schema structure. Used by schema-separation tests: a read model's paths are the
 * complete set of fields it can ever carry, so a forbidden field is provably absent.
 * A `record` (open key set) is reported as `<path>.*`.
 */
export function schemaPaths(schema: ZodType, maxDepth = 12): string[] {
  const out = new Set<string>();
  const walk = (s: ZodType, path: string, depth: number) => {
    if (depth > maxDepth) return;
    const d = def(s);
    switch (d.type) {
      case 'object':
        for (const [k, v] of Object.entries(d.shape ?? {})) {
          const p = path ? `${path}.${k}` : k;
          out.add(p);
          walk(v, p, depth + 1);
        }
        return;
      case 'array':
        if (d.element) walk(d.element, `${path}[]`, depth + 1);
        return;
      case 'record':
        out.add(`${path}.*`);
        if (d.valueType) walk(d.valueType, `${path}.*`, depth + 1);
        return;
      case 'union':
        for (const o of d.options ?? []) walk(o, path, depth + 1);
        return;
      case 'intersection':
        if (d.left) walk(d.left, path, depth + 1);
        if (d.right) walk(d.right, path, depth + 1);
        return;
      case 'pipe':
        if (d.in) walk(d.in, path, depth + 1);
        if (d.out) walk(d.out, path, depth + 1);
        return;
      case 'lazy':
        if (d.getter) walk(d.getter(), path, depth + 1);
        return;
      default:
        if (d.innerType) walk(d.innerType, path, depth + 1);
    }
  };
  walk(schema, '', 0);
  return [...out].sort();
}

/** The field names (last path segments) a schema can produce. */
export function schemaFieldNames(schema: ZodType): Set<string> {
  return new Set(schemaPaths(schema).map((p) => p.replace(/\[\]/g, '').split('.').pop() as string));
}
