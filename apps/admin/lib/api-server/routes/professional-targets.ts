import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Actor } from '@aptamind/contracts';
import {
  createTargetInputSchema,
  diffVersions,
  editTargetInputSchema,
  idSchema,
  ProfessionalError,
  type ProfessionalDomain,
  reorderTargetsInputSchema,
  type TargetAction,
  targetActionInputSchema,
  viewTarget,
  viewVersion,
} from '@aptamind/professional';
import { idempotencyKey } from './professional-shared';

/**
 * Career target routes (P5.1, domain doc §9/§12). Contract:
 * docs/programme/contracts/professional-career-targets.md. Registered inside the Professional
 * route plugin, so its redacting logger and error handler apply.
 *
 * Sensitive data is off by default (R-30, DECISION_LOG PR #24): a target's viability part and
 * rationale are returned only with `include=sensitive`, and writing them requires it too — the
 * one place a future authorization check goes.
 */
const includeShape = { include: z.enum(['sensitive']).optional() };
const includeQuery = z.strictObject(includeShape);
const diffQuery = z.strictObject({
  ...includeShape,
  from: z
    .string()
    .regex(/^[0-9]{1,6}$/)
    .transform(Number),
  to: z
    .string()
    .regex(/^[0-9]{1,6}$/)
    .transform(Number),
});
const subjectParams = z.object({ id: idSchema('subject') });
const targetParams = z.object({ id: idSchema('careerTarget') });
const versionParams = z.object({
  id: idSchema('careerTarget'),
  version: z
    .string()
    .regex(/^[1-9][0-9]{0,5}$/)
    .transform(Number),
});
const ACTIONS = [
  'activate',
  'pause',
  'archive',
  'accept',
  'decline',
] as const satisfies readonly TargetAction[];

const sensitive = (q: { include?: 'sensitive' }) => q.include === 'sensitive';

/**
 * Writing a sensitive part needs the same `include=sensitive` as reading it. Checked on the raw
 * body, before validation, so a sensitive value is refused whether or not it is well-formed.
 */
function requireSensitive(body: unknown, includeSensitive: boolean): void {
  if (includeSensitive || !body || typeof body !== 'object') return;
  const b = body as Record<string, unknown>;
  if (b.viability !== undefined || b.rationale !== undefined)
    throw new ProfessionalError(
      'sensitive_not_included',
      'Writing viability or rationale requires include=sensitive',
    );
}

export function professionalTargetRoutes(
  app: FastifyInstance,
  professional: ProfessionalDomain,
  assertSubjectAccess: (actor: Actor, subjectId: string) => void,
): void {
  const targets = professional.targets;

  app.post('/api/professional/subjects/:id/targets', async (req, reply) => {
    const { id } = subjectParams.parse(req.params);
    assertSubjectAccess(req.ctx.actor, id);
    const inc = sensitive(includeQuery.parse(req.query));
    requireSensitive(req.body, inc);
    const input = createTargetInputSchema.parse(req.body);
    const { target, created } = await targets.create(id, input, req.ctx.actor, idempotencyKey(req));
    return reply.status(created ? 201 : 200).send({ target: viewTarget(target, inc), created });
  });

  app.get('/api/professional/subjects/:id/targets', async (req) => {
    const { id } = subjectParams.parse(req.params);
    assertSubjectAccess(req.ctx.actor, id);
    const { include, ...query } = (req.query ?? {}) as Record<string, unknown>;
    const inc = sensitive(includeQuery.parse({ include }));
    const page = await targets.list(id, query);
    return { ...page, items: page.items.map((t) => viewTarget(t, inc)) };
  });

  app.post('/api/professional/subjects/:id/targets/reorder', async (req) => {
    const { id } = subjectParams.parse(req.params);
    assertSubjectAccess(req.ctx.actor, id);
    const inc = sensitive(includeQuery.parse(req.query));
    const items = await targets.reorder(id, reorderTargetsInputSchema.parse(req.body), req.ctx.actor);
    return { items: items.map((t) => viewTarget(t, inc)) };
  });

  app.get('/api/professional/targets/:id', async (req) => {
    const { id } = targetParams.parse(req.params);
    const inc = sensitive(includeQuery.parse(req.query));
    const target = await targets.get(id);
    assertSubjectAccess(req.ctx.actor, target.subjectId);
    const events = await professional.events.list({ entity: { kind: 'career_target', id } }, 20);
    return { target: viewTarget(target, inc), events };
  });

  app.patch('/api/professional/targets/:id', async (req) => {
    const { id } = targetParams.parse(req.params);
    const inc = sensitive(includeQuery.parse(req.query));
    requireSensitive(req.body, inc);
    const input = editTargetInputSchema.parse(req.body);
    const current = await targets.get(id);
    assertSubjectAccess(req.ctx.actor, current.subjectId);
    return { target: viewTarget(await targets.edit(id, input, req.ctx.actor), inc) };
  });

  for (const action of ACTIONS) {
    app.post(`/api/professional/targets/:id/${action}`, async (req) => {
      const { id } = targetParams.parse(req.params);
      const inc = sensitive(includeQuery.parse(req.query));
      const input = targetActionInputSchema.parse(req.body);
      const current = await targets.get(id);
      assertSubjectAccess(req.ctx.actor, current.subjectId);
      return { target: viewTarget(await targets.act(id, action, input, req.ctx.actor), inc) };
    });
  }

  app.get('/api/professional/targets/:id/versions', async (req) => {
    const { id } = targetParams.parse(req.params);
    const { include, ...query } = (req.query ?? {}) as Record<string, unknown>;
    const inc = sensitive(includeQuery.parse({ include }));
    const target = await targets.get(id);
    assertSubjectAccess(req.ctx.actor, target.subjectId);
    const page = await targets.listVersions(id, query);
    return { ...page, items: page.items.map((v) => viewVersion(v, inc)) };
  });

  app.get('/api/professional/targets/:id/versions/:version', async (req) => {
    const { id, version } = versionParams.parse(req.params);
    const inc = sensitive(includeQuery.parse(req.query));
    const target = await targets.get(id);
    assertSubjectAccess(req.ctx.actor, target.subjectId);
    return { version: viewVersion(await targets.version(id, version), inc) };
  });

  app.get('/api/professional/targets/:id/diff', async (req) => {
    const { id } = targetParams.parse(req.params);
    const q = diffQuery.parse(req.query);
    const target = await targets.get(id);
    assertSubjectAccess(req.ctx.actor, target.subjectId);
    const [a, b] = await Promise.all([targets.version(id, q.from), targets.version(id, q.to)]);
    return diffVersions(a, b, sensitive(q));
  });
}
