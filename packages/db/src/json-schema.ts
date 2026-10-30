import type { Document } from 'mongodb';
import type { ZodType } from 'zod';

/**
 * Derives a MongoDB `$jsonSchema` validator from a collection's Zod schema, so the shape the
 * code declares is also enforced by the server (defence in depth against writes that bypass
 * the TypeScript types: raw `$set`s, scripts, other processes, a future bug).
 *
 * The validator is structural: BSON types, required fields, enums/literals, nested objects and
 * array items, down to `maxDepth`. It deliberately does not restrict unknown extra fields
 * (documents evolve additively) nor express refinements (lengths, regexes, numeric ranges beyond
 * sign), which stay in Zod.
 */
export function zodToMongoJsonSchema(schema: ZodType, maxDepth = 6): Document {
  const out = convert(schema, 0, maxDepth);
  return out ?? { bsonType: 'object' };
}

interface Def {
  type: string;
  innerType?: ZodType;
  shape?: Record<string, ZodType>;
  element?: ZodType;
  entries?: Record<string, string | number>;
  values?: unknown[];
  options?: ZodType[];
  checks?: Array<{ _zod: { def: { check?: string; format?: string } } }>;
  in?: ZodType;
  out?: ZodType;
  getter?: () => ZodType;
}

const def = (s: ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

/** Wrappers that make a property optional in the stored document. */
function unwrapOptional(s: ZodType): { inner: ZodType; optional: boolean } {
  let cur = s;
  let optional = false;
  for (let i = 0; i < 10; i++) {
    const d = def(cur);
    if ((d.type === 'optional' || d.type === 'default' || d.type === 'prefault') && d.innerType) {
      optional = true;
      cur = d.innerType;
    } else if ((d.type === 'readonly' || d.type === 'catch') && d.innerType) cur = d.innerType;
    else break;
  }
  return { inner: cur, optional };
}

function withNull(schema: Document | null): Document | null {
  if (!schema) return null;
  if (schema.enum) return { ...schema, enum: [...(schema.enum as unknown[]), null] };
  if (schema.bsonType) {
    const t = Array.isArray(schema.bsonType) ? schema.bsonType : [schema.bsonType];
    return { ...schema, bsonType: [...t, 'null'] };
  }
  return null; // unconstrained already allows null
}

function convert(s: ZodType, depth: number, maxDepth: number): Document | null {
  const d = def(s);
  switch (d.type) {
    case 'string':
      return { bsonType: 'string' };
    case 'boolean':
      return { bsonType: 'bool' };
    case 'date':
      return { bsonType: 'date' };
    case 'number': {
      const int = (d.checks ?? []).some((c) => /int/.test(c._zod.def.format ?? ''));
      // The driver stores integers as int32 when they fit and double otherwise.
      return { bsonType: int ? ['int', 'long', 'double'] : ['int', 'long', 'double', 'decimal'] };
    }
    case 'enum':
      return { enum: Object.values(d.entries ?? {}) };
    case 'literal':
      return { enum: [...(d.values ?? [])] };
    case 'nullable':
      return d.innerType ? withNull(convert(d.innerType, depth, maxDepth)) : null;
    case 'optional':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
      return d.innerType ? convert(d.innerType, depth, maxDepth) : null;
    case 'pipe':
      return d.in ? convert(d.in, depth, maxDepth) : null;
    case 'lazy':
      return null;
    case 'array': {
      if (depth >= maxDepth || !d.element) return { bsonType: 'array' };
      const items = convert(d.element, depth + 1, maxDepth);
      return items ? { bsonType: 'array', items } : { bsonType: 'array' };
    }
    case 'record':
      return { bsonType: 'object' };
    case 'object': {
      if (depth >= maxDepth || !d.shape) return { bsonType: 'object' };
      const properties: Document = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(d.shape)) {
        const { inner, optional } = unwrapOptional(value);
        const converted = convert(inner, depth + 1, maxDepth);
        if (converted) properties[key] = converted;
        if (!optional) required.push(key);
      }
      return {
        bsonType: 'object',
        ...(required.length ? { required } : {}),
        ...(Object.keys(properties).length ? { properties } : {}),
      };
    }
    case 'union': {
      // Unions of literals/enums become one enum; anything else is left unconstrained.
      const parts = (d.options ?? []).map((o) => convert(o, depth, maxDepth));
      if (parts.length && parts.every((p) => p && Array.isArray(p.enum) && Object.keys(p).length === 1)) {
        return { enum: parts.flatMap((p) => p?.enum as unknown[]) };
      }
      return null;
    }
    default:
      return null; // unknown / any / custom / json values: unconstrained
  }
}
