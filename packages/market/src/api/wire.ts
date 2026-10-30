import { z } from 'zod';

/** An ISO-8601 timestamp as the API serialises a BSON date (`Date#toJSON`). */
export const isoDateTime = z.iso.datetime({ offset: true });

type AnySchema = z.ZodType;
interface Def {
  type: string;
  shape?: Record<string, AnySchema>;
  element?: AnySchema;
  innerType?: AnySchema;
  keyType?: AnySchema;
  valueType?: AnySchema;
  options?: AnySchema[];
  in?: AnySchema;
  out?: AnySchema;
  left?: AnySchema;
  right?: AnySchema;
  items?: AnySchema[];
}

const cache = new WeakMap<AnySchema, AnySchema>();

/**
 * The JSON wire form of a document schema: every `z.date()` becomes an ISO-8601 string, and
 * `.default(…)` becomes optional (the API returns stored documents, whose defaults were applied
 * when they were written). Everything else — enums, nullability, nesting — is kept, so a
 * response DTO derived from a collection schema cannot drift from it.
 *
 * Objects keep Zod's default (non-strict) behaviour: documents evolve additively, so an
 * extra field is not a contract break. Summary DTOs that must *exclude* fields are written
 * explicitly with `z.strictObject`.
 */
export function toWire<T extends AnySchema>(schema: T): AnySchema {
  const hit = cache.get(schema);
  if (hit) return hit;
  const out = convert(schema);
  cache.set(schema, out);
  return out;
}

function convert(schema: AnySchema): AnySchema {
  const def = (schema as unknown as { _zod: { def: Def } })._zod.def;
  switch (def.type) {
    case 'date':
      return isoDateTime;
    case 'object':
      return z.object(Object.fromEntries(Object.entries(def.shape ?? {}).map(([k, v]) => [k, toWire(v)])));
    case 'array':
      return z.array(toWire(def.element as AnySchema));
    case 'optional':
      return toWire(def.innerType as AnySchema).optional();
    case 'nullable':
      return toWire(def.innerType as AnySchema).nullable();
    case 'default':
    case 'prefault':
    case 'catch':
      return toWire(def.innerType as AnySchema).optional();
    case 'readonly':
    case 'nonoptional':
      return toWire(def.innerType as AnySchema);
    case 'record':
      return z.record(def.keyType as z.ZodString, toWire(def.valueType as AnySchema));
    case 'union':
      return z.union((def.options ?? []).map((o) => toWire(o)) as [AnySchema, ...AnySchema[]]);
    case 'intersection':
      return z.intersection(toWire(def.left as AnySchema), toWire(def.right as AnySchema));
    case 'tuple':
      return z.tuple((def.items ?? []).map((i) => toWire(i)) as [AnySchema, ...AnySchema[]]);
    case 'pipe':
      // A transform/pipe validates its input shape on the wire (the output never leaves the server).
      return toWire(def.in as AnySchema);
    default:
      // Scalars, enums, literals, unknown, and lazy JSON values (which hold no dates).
      return schema;
  }
}
