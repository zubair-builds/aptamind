import type { FastifyRequest } from 'fastify';
import { type Actor, type RequestContext, UNAUTHENTICATED_INTERNAL_OPERATOR } from '@aptamind/contracts';

/**
 * Authentication seam.
 *
 * v0.1 has NO authentication (explicitly out of scope). Every request is attributed to the
 * unauthenticated internal operator. When auth is introduced, only this function changes:
 * it will derive the actor from a verified session/token and reject unauthorized requests.
 * Domain services already take an `Actor`, so they are unaffected.
 *
 * Consequence: this API must only be reachable on a private network (see
 * docs/runbooks/local-development.md). Config refuses API_HOST=0.0.0.0 in production.
 */
export function resolveActor(_req: FastifyRequest): Actor {
  return UNAUTHENTICATED_INTERNAL_OPERATOR;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}
