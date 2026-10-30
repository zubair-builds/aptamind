import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError } from '@aptamind/contracts';
import type { Platform } from '@aptamind/platform';
import { DEFAULT_CAPABILITY_QUEUES, FANOUT_QUEUE, nodeQueueName } from '@aptamind/workflows';

export async function opsRoutes(app: FastifyInstance, { platform }: { platform: Platform }) {
  const { market, runtime, transport, artifacts, artifactAccess } = platform;

  /**
   * FE-P6: artifacts owned by a private domain (Professional) are refused exactly like an
   * unknown id — same status, code, message and details — so these routes are no existence
   * oracle. The decision comes from the platform's guard; this module imports no domain.
   */
  const servableArtifact = async (id: string) => {
    const doc = await artifacts.get(id);
    if (await artifactAccess.isRestricted(doc)) throw new NotFoundError('Artifact', id);
    return doc;
  };

  const queueSnapshot = async () => {
    const names = [...DEFAULT_CAPABILITY_QUEUES.map(nodeQueueName), FANOUT_QUEUE];
    const counts = await Promise.all(names.map(async (n) => ({ queue: n, ...(await transport.counts(n)) })));
    return counts;
  };

  app.get('/api/dashboard', async (req) => {
    const { hours } = z
      .object({
        hours: z.coerce
          .number()
          .min(1)
          .max(24 * 30)
          .default(24),
      })
      .parse(req.query);
    const [summary, runs, queues, overdue] = await Promise.all([
      market.dashboard.summary(hours * 3600_000),
      runtime.queries.stats(new Date(Date.now() - hours * 3600_000)),
      queueSnapshot(),
      market.freshness.overdueSources(),
    ]);
    const due = await market.freshness.jobsDueForVerification(1000);
    return {
      ...summary,
      runs,
      queues,
      freshness: { overdueSources: overdue, jobsDueForVerification: due.length },
    };
  });

  app.get('/api/metrics/data-quality', async (req) => {
    const { days } = z.object({ days: z.coerce.number().min(1).max(90).default(7) }).parse(req.query);
    return market.dashboard.dataQuality(days * 24 * 3600_000);
  });

  app.get('/api/metrics/queues', async () => ({ items: await queueSnapshot() }));

  app.get('/api/artifacts/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return servableArtifact(id);
  });

  /** Raw artifact content (internal only; artifacts are private by default). */
  app.get('/api/artifacts/:id/content', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { preview } = z
      .object({ preview: z.coerce.number().int().min(0).max(5_000_000).default(0) })
      .parse(req.query);
    const doc = await servableArtifact(id);
    const bytes = await artifacts.readBytes({ artifactId: id });
    const body = preview ? bytes.slice(0, preview) : bytes;
    // Served as text/plain so browsers never execute stored third-party HTML/JS.
    const textual = /^(text\/|application\/(json|x-ndjson|xml))/.test(doc.mimeType);
    return reply
      .header('content-type', textual ? 'text/plain; charset=utf-8' : 'application/octet-stream')
      .header('x-artifact-mime-type', doc.mimeType)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .send(Buffer.from(body));
  });
}
