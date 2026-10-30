import { z } from 'zod';
import { jsonValueSchema } from '@aptamind/contracts';
import { defineCapability, recordSetSchema, recordsInputSchema } from '@aptamind/workflow-sdk';
import { getPath, setPath } from './paths';

const transformEnum = z.enum([
  'trim',
  'lower',
  'upper',
  'number',
  'boolean',
  'null_if_empty',
  'collapse_whitespace',
]);
const fieldMapping = z.union([
  z.string(),
  z.object({
    path: z.string(),
    transforms: z.array(transformEnum).default([]),
    default: jsonValueSchema.optional(),
  }),
]);

function applyTransform(v: unknown, t: z.infer<typeof transformEnum>): unknown {
  switch (t) {
    case 'trim':
      return typeof v === 'string' ? v.trim() : v;
    case 'lower':
      return typeof v === 'string' ? v.toLowerCase() : v;
    case 'upper':
      return typeof v === 'string' ? v.toUpperCase() : v;
    case 'collapse_whitespace':
      return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v;
    case 'number': {
      if (typeof v === 'number') return v;
      if (typeof v !== 'string' || v.trim() === '') return null;
      const n = Number(v.replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') return ['true', 'yes', '1', 'y'].includes(v.trim().toLowerCase());
      return null;
    case 'null_if_empty':
      return typeof v === 'string' && v.trim() === '' ? null : v;
  }
}

export function mapRecord(
  record: unknown,
  mapping: Record<string, z.infer<typeof fieldMapping>>,
  constants: Record<string, unknown>,
  keepUnmapped: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> =
    keepUnmapped && record && typeof record === 'object' ? { ...(record as object) } : {};
  for (const [target, spec] of Object.entries(mapping)) {
    const s =
      typeof spec === 'string'
        ? { path: spec, transforms: [] as Array<z.infer<typeof transformEnum>>, default: undefined }
        : spec;
    let v = getPath(record, s.path);
    for (const t of s.transforms) v = applyTransform(v, t);
    if ((v === undefined || v === null) && s.default !== undefined) v = s.default;
    if (v !== undefined) setPath(out, target, v);
  }
  for (const [k, v] of Object.entries(constants)) setPath(out, k, v);
  return out;
}

/** Map Fields: declarative field mapping with a fixed set of safe transforms. */
export const mapFields = defineCapability({
  type: 'core.map_fields',
  version: 1,
  title: 'Map Fields',
  description: 'Maps each record to a new shape using dot paths and a fixed set of safe transforms.',
  category: 'transform',
  inputSchema: z.object({ records: recordsInputSchema }),
  outputSchema: z.object({ records: recordSetSchema, count: z.number().int() }),
  configSchema: z.object({
    mapping: z.record(z.string(), fieldMapping),
    constants: z.record(z.string(), jsonValueSchema).default({}),
    keepUnmapped: z.boolean().default(false),
  }),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false, defaultTimeoutMs: 10 * 60_000 },
  async execute(ctx, input, config) {
    const out: unknown[] = [];
    for await (const r of ctx.records.read(input.records))
      out.push(mapRecord(r, config.mapping, config.constants, config.keepUnmapped));
    return { records: await ctx.records.write(out), count: out.length };
  },
});

export const conditionSchema = z.object({
  path: z.string(),
  op: z.enum([
    'eq',
    'neq',
    'in',
    'nin',
    'exists',
    'not_exists',
    'contains',
    'starts_with',
    'gt',
    'gte',
    'lt',
    'lte',
    'empty',
    'not_empty',
  ]),
  value: jsonValueSchema.optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

export function evaluateCondition(record: unknown, c: Condition): boolean {
  const v = getPath(record, c.path);
  switch (c.op) {
    case 'eq':
      return v === c.value;
    case 'neq':
      return v !== c.value;
    case 'in':
      return Array.isArray(c.value) && c.value.includes(v as never);
    case 'nin':
      return Array.isArray(c.value) && !c.value.includes(v as never);
    case 'exists':
      return v !== undefined && v !== null;
    case 'not_exists':
      return v === undefined || v === null;
    case 'empty':
      return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    case 'not_empty':
      return !(v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0));
    case 'contains':
      return (
        (typeof v === 'string' &&
          typeof c.value === 'string' &&
          v.toLowerCase().includes(c.value.toLowerCase())) ||
        (Array.isArray(v) && v.includes(c.value as never))
      );
    case 'starts_with':
      return (
        typeof v === 'string' &&
        typeof c.value === 'string' &&
        v.toLowerCase().startsWith(c.value.toLowerCase())
      );
    case 'gt':
      return typeof v === 'number' && typeof c.value === 'number' && v > c.value;
    case 'gte':
      return typeof v === 'number' && typeof c.value === 'number' && v >= c.value;
    case 'lt':
      return typeof v === 'number' && typeof c.value === 'number' && v < c.value;
    case 'lte':
      return typeof v === 'number' && typeof c.value === 'number' && v <= c.value;
  }
}

export const filterRecords = defineCapability({
  type: 'core.filter',
  version: 1,
  title: 'Filter',
  description: 'Keeps records matching all/any declarative conditions.',
  category: 'transform',
  inputSchema: z.object({ records: recordsInputSchema }),
  outputSchema: z.object({ records: recordSetSchema, count: z.number().int(), dropped: z.number().int() }),
  configSchema: z.object({
    conditions: z.array(conditionSchema).min(1),
    mode: z.enum(['all', 'any']).default('all'),
  }),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false, defaultTimeoutMs: 10 * 60_000 },
  async execute(ctx, input, config) {
    const kept: unknown[] = [];
    let dropped = 0;
    for await (const r of ctx.records.read(input.records)) {
      const ok =
        config.mode === 'all'
          ? config.conditions.every((c) => evaluateCondition(r, c))
          : config.conditions.some((c) => evaluateCondition(r, c));
      if (ok) kept.push(r);
      else dropped += 1;
    }
    return { records: await ctx.records.write(kept), count: kept.length, dropped };
  },
});

export const dedupeRecords = defineCapability({
  type: 'core.dedupe_records',
  version: 1,
  title: 'Deduplicate Records',
  description:
    'Drops records whose key (combination of paths, case-insensitive) was already seen; keeps the first.',
  category: 'transform',
  inputSchema: z.object({ records: recordsInputSchema }),
  outputSchema: z.object({ records: recordSetSchema, count: z.number().int(), duplicates: z.number().int() }),
  configSchema: z.object({
    keyPaths: z.array(z.string()).min(1),
    caseInsensitive: z.boolean().default(true),
  }),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false, defaultTimeoutMs: 10 * 60_000 },
  async execute(ctx, input, config) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    let duplicates = 0;
    for await (const r of ctx.records.read(input.records)) {
      let key = JSON.stringify(config.keyPaths.map((p) => getPath(r, p) ?? null));
      if (config.caseInsensitive) key = key.toLowerCase();
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      out.push(r);
    }
    return { records: await ctx.records.write(out), count: out.length, duplicates };
  },
});
