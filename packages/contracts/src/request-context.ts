import { z } from 'zod';

/**
 * Actor / request-context seam.
 *
 * Authentication is explicitly out of scope for Market Foundation v0.1. Every mutating
 * domain operation nevertheless receives an `Actor`, so that authentication and
 * authorization can later be introduced at the API boundary without changing domain APIs.
 *
 * Until then the API attributes every request to the `internal-operator` actor, and the
 * worker attributes automated changes to `system`.
 */
export const actorSchema = z.object({
  kind: z.enum(['system', 'internal-operator', 'workflow']),
  id: z.string(),
  displayName: z.string().optional(),
});
export type Actor = z.infer<typeof actorSchema>;

export const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'system' };
export const UNAUTHENTICATED_INTERNAL_OPERATOR: Actor = {
  kind: 'internal-operator',
  id: 'unauthenticated-internal-operator',
  displayName: 'Internal operator (no auth in v0.1)',
};

export function workflowActor(runId: string): Actor {
  return { kind: 'workflow', id: runId };
}

export interface RequestContext {
  requestId: string;
  actor: Actor;
}
