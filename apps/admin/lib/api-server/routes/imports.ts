import type { FastifyInstance } from 'fastify';
import {
  createImport,
  getImport,
  idParamsSchema,
  importCreateQuerySchema,
  importListQuerySchema,
  type ImportRunCollection,
  listImports,
  noQuerySchema,
} from '@aptamind/market';
import type { Platform } from '@aptamind/platform';
import { uploadedFile, uploadPreParsing } from './upload';

/** Operator file imports (market-imports.md): upload + run + a record that traces both. */
export async function importRoutes(app: FastifyInstance, { platform }: { platform: Platform }) {
  const { market, runtime } = platform;
  const runs = runtime.engine.runs as unknown as ImportRunCollection;

  app.post(
    '/api/imports',
    {
      bodyLimit: 200 * 1024 * 1024,
      // The query is checked here first, so a bad target is refused before the body is read.
      preParsing: uploadPreParsing(market, (req) => importCreateQuerySchema.parse(req.query).sourceId),
    },
    async (req, reply) => {
      const q = importCreateQuerySchema.parse(req.query);
      const { body, contentType } = uploadedFile(req);
      const record = await createImport(
        market,
        { type: q.type, sourceId: q.sourceId, fileName: q.fileName, body, contentType },
        req.ctx.actor,
      );
      return reply.status(201).send(await getImport(market, runs, record._id));
    },
  );

  app.get('/api/imports', async (req) => listImports(market, runs, importListQuerySchema.parse(req.query)));

  app.get('/api/imports/:id', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    return getImport(market, runs, id);
  });
}
