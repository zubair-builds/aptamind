import type { Document } from 'mongodb';
import type { ZodType } from 'zod';
import { zodToMongoJsonSchema } from '@aptamind/db';

interface Def {
  type: string;
  innerType?: ZodType;
  in?: ZodType;
  shape?: Record<string, ZodType>;
  element?: ZodType;
  checks?: Array<{
    _zod: { def: { check?: string; format?: string; pattern?: RegExp; minimum?: number; maximum?: number } };
  }>;
}
const def = (s: ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;
const WRAPPERS = new Set(['optional', 'default', 'prefault', 'readonly', 'catch', 'nullable']);

/**
 * Server-side validator for a Professional collection (defence in depth, ADR-0018), built
 * stream-locally on top of the Foundation derivation (`zodToMongoJsonSchema`, unchanged):
 *
 * - string `pattern`s from the Zod regexes — id prefixes (`psub_…`), machine codes (reason,
 *   reasonCode, error codes, warnings), hashes, tokens — so free text or foreign ids written
 *   around the application boundary are rejected by MongoDB itself;
 * - string `minLength`/`maxLength` from the Zod length checks (e.g. quotes ≤ 300);
 * - `additionalProperties: false` at the top level (the schema lists the full field set);
 * - optional `$nor` query clauses for cross-field rules (e.g. LinkedIn is never fetched).
 *
 * Regexes with flags are not transferred (their semantics may differ in PCRE); they stay in Zod.
 */
export function professionalValidator(
  schema: ZodType,
  opts: { closed?: boolean; nor?: Document[] } = {},
): Document {
  const json = zodToMongoJsonSchema(schema);
  annotate(schema, json);
  if (opts.closed !== false) json.additionalProperties = false;
  return opts.nor?.length ? { $jsonSchema: json, $nor: opts.nor } : { $jsonSchema: json };
}

/**
 * In PCRE (MongoDB) a final `$` also matches before a trailing newline (JavaScript's does not),
 * so `'operator_created\n'` would pass `^[a-z_]+$` server-side. A trailing unescaped `$` is
 * rewritten to `(?!\n)$`, which only matches at the true end.
 */
export function serverPattern(source: string): string {
  const escaped = /(^|[^\\])(\\\\)*\\\$$/.test(source);
  return source.endsWith('$') && !escaped ? `${source.slice(0, -1)}(?!\\n)$` : source;
}

function annotate(schema: ZodType, json: Document | undefined): void {
  if (!json) return;
  let s = schema;
  for (let i = 0; i < 10; i++) {
    const d = def(s);
    if (WRAPPERS.has(d.type) && d.innerType) s = d.innerType;
    else if (d.type === 'pipe' && d.in) s = d.in;
    else break;
  }
  const d = def(s);
  switch (d.type) {
    case 'string': {
      const types = Array.isArray(json.bsonType) ? json.bsonType : [json.bsonType];
      if (!types.includes('string')) return;
      const regexes: RegExp[] = [];
      for (const c of d.checks ?? []) {
        const cd = c._zod.def;
        if (cd.check === 'string_format' && cd.format === 'regex' && cd.pattern) regexes.push(cd.pattern);
        if (cd.check === 'min_length' && cd.minimum !== undefined) json.minLength = cd.minimum;
        if (cd.check === 'max_length' && cd.maximum !== undefined) json.maxLength = cd.maximum;
      }
      if (regexes.length === 1 && regexes[0]!.flags === '') json.pattern = serverPattern(regexes[0]!.source);
      return;
    }
    case 'object':
      for (const [k, v] of Object.entries(d.shape ?? {})) annotate(v, json.properties?.[k]);
      return;
    case 'array':
      if (d.element) annotate(d.element, json.items);
      return;
    default:
  }
}
