import { z } from 'zod';

/**
 * Actor / request-context seam.
 *
 * Signed-in people are `user` actors (FE-5, ADR-0022). Before that milestone,
 * authentication was out of scope for Market Foundation v0.1. Every mutating
 * domain operation nevertheless receives an `Actor`, so that authentication and
 * authorization can later be introduced at the API boundary without changing domain APIs.
 *
 * Until then the API attributes every request to the `internal-operator` actor, and the
 * worker attributes automated changes to `system`.
 */
const systemActorSchema = z.object({
  kind: z.literal('system'),
  id: z.string(),
  displayName: z.string().optional(),
});
const internalOperatorActorSchema = z.object({
  kind: z.literal('internal-operator'),
  id: z.string(),
  displayName: z.string().optional(),
});
const workflowActorSchema = z.object({
  kind: z.literal('workflow'),
  id: z.string(),
  displayName: z.string().optional(),
});

/**
 * A signed-in person (FE-5, ADR-0022). `id` mirrors `userId` so `{ kind, id }` copies stay valid;
 * `tokenId` is set when the request came through an API token (MCP).
 */
export const userActorSchema = z
  .object({
    kind: z.literal('user'),
    id: z.string(),
    userId: z.string().min(1),
    workspaceId: z.string().min(1),
    displayName: z.string().optional(),
    roles: z.array(z.string()).optional(),
    tokenId: z.string().optional(),
  })
  .refine((a) => a.id === a.userId, { message: 'user actor id must equal userId', path: ['id'] });

export const actorSchema = z.discriminatedUnion('kind', [
  systemActorSchema,
  internalOperatorActorSchema,
  workflowActorSchema,
  userActorSchema,
]);
export type Actor = z.infer<typeof actorSchema>;
export type ActorKind = Actor['kind'];
export type UserActor = z.infer<typeof userActorSchema>;

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
