import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToMongoJsonSchema } from './json-schema';

describe('zodToMongoJsonSchema', () => {
  it('derives BSON types, required fields, enums, nullability and nesting', () => {
    const schema = z.object({
      _id: z.string(),
      state: z.enum(['A', 'B']),
      count: z.number().int().min(0),
      ratio: z.number(),
      at: z.date(),
      note: z.string().nullable(),
      maybe: z.string().optional(),
      tags: z.array(z.string()).default([]),
      nested: z.object({ ok: z.boolean(), kind: z.union([z.literal('x'), z.literal('y')]) }),
      bag: z.record(z.string(), z.unknown()),
      anything: z.unknown(),
    });
    expect(zodToMongoJsonSchema(schema)).toEqual({
      bsonType: 'object',
      required: ['_id', 'state', 'count', 'ratio', 'at', 'note', 'nested', 'bag', 'anything'],
      properties: {
        _id: { bsonType: 'string' },
        state: { enum: ['A', 'B'] },
        count: { bsonType: ['int', 'long', 'double'] },
        ratio: { bsonType: ['int', 'long', 'double', 'decimal'] },
        at: { bsonType: 'date' },
        note: { bsonType: ['string', 'null'] },
        maybe: { bsonType: 'string' },
        tags: { bsonType: 'array', items: { bsonType: 'string' } },
        nested: {
          bsonType: 'object',
          required: ['ok', 'kind'],
          properties: { ok: { bsonType: 'bool' }, kind: { enum: ['x', 'y'] } },
        },
        bag: { bsonType: 'object' },
      },
    });
  });
});
