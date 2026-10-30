import type { FastifyRequest } from 'fastify';
import { idempotencyKeySchema } from '@aptamind/professional';

/** The request's `Idempotency-Key` header, validated (an opaque token; shared by Professional routes). */
export function idempotencyKey(req: FastifyRequest): string | undefined {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return undefined;
  return idempotencyKeySchema.parse(Array.isArray(raw) ? raw[0] : raw);
}
