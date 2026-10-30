import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MARKET_ENUMS } from '@aptamind/market';
import type { Platform } from '@aptamind/platform';
import { AUTHORITY_TIERS, CONFIDENCE_LEVELS, FACT_STATUSES } from '@aptamind/provenance';
import { RUN_STATES } from '@aptamind/workflows';

/**
 * `GET /api/meta/enums` (Admin ask API-10): display-ready enums with default labels, keyed
 * `<catalog>.<name>`. Each domain supplies its own catalog (Market: `MARKET_ENUMS`, M7.7); the
 * enums of the frozen Foundation packages (fact status, confidence, authority tiers, run states)
 * are the `core.*` catalog owned here, built from their Foundation constants. Labels are defaults
 * and `description` marks what must not be blurred. The query schema is derived from the
 * registered catalogs: registering a catalog is the only change a new domain needs.
 */

type Catalog = typeof MARKET_ENUMS;
type Labels<V extends string> = Record<V, string | { label: string; description: string }>;

function entry<const V extends string>(values: readonly V[], labels: Labels<V>, appliesTo: string[]) {
  return {
    appliesTo,
    values: values.map((value) => {
      const l = labels[value];
      if (typeof l === 'string') return { value, label: l };
      return { value, label: l.label, description: l.description };
    }),
  };
}

/** Foundation enums (`@aptamind/provenance`, `@aptamind/workflows`). */
export const CORE_ENUMS: Catalog = {
  'core.factStatus': entry(
    FACT_STATUSES,
    {
      known: 'Known',
      unknown: { label: 'Unknown', description: 'We do not know; never render as false, 0 or "No".' },
      conflicting: { label: 'Conflicting', description: 'Sources disagree; show the conflicts.' },
    },
    ['<fact>.status'],
  ),
  'core.confidenceLevel': entry(
    CONFIDENCE_LEVELS,
    { high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unknown' },
    ['<fact>.confidence.level', 'GET /api/jobs?minConfidence'],
  ),
  'core.authorityTier': entry(
    AUTHORITY_TIERS,
    {
      official_registry: 'Official registry',
      official_ats: 'Employer ATS',
      official_site: 'Employer website',
      third_party: 'Third party',
      operator: 'Operator decision',
      inferred: 'Inferred',
    },
    ['<evidence>.authority', 'source.authority.tier'],
  ),
  'core.runState': entry(
    RUN_STATES,
    {
      PENDING: 'Pending',
      RUNNING: 'Running',
      WAITING: 'Waiting',
      CANCELLING: 'Cancelling',
      COMPLETED: 'Completed',
      FAILED: 'Failed',
      CANCELLED: 'Cancelled',
    },
    [
      'run.state',
      'GET /api/runs?state',
      'GET /api/sources/:id/runs?state',
      'GET /api/{companies,jobs}/:id/runs?state',
    ],
  ),
};

/** The registered catalogs; `?domain=` accepts exactly these names. */
export const ENUM_CATALOGS: Record<string, Catalog> = { core: CORE_ENUMS, market: MARKET_ENUMS };

const catalogNames = Object.keys(ENUM_CATALOGS) as [string, ...string[]];
export const enumsQuerySchema = z.strictObject({ domain: z.enum(catalogNames).optional() });

const enumValueDto = z.strictObject({
  value: z.string(),
  label: z.string().min(1),
  description: z.string().optional(),
});
export const enumsResponseDto = z.strictObject({
  enums: z.record(
    z.string().regex(/^[a-z]+\.[a-zA-Z]+$/),
    z.strictObject({ appliesTo: z.array(z.string()).min(1), values: z.array(enumValueDto).min(1) }),
  ),
});

export async function metaRoutes(app: FastifyInstance, _opts: { platform: Platform }) {
  app.get('/api/meta/enums', async (req, reply) => {
    const { domain } = enumsQuerySchema.parse(req.query);
    const enums: Catalog = Object.assign(
      {},
      ...Object.entries(ENUM_CATALOGS)
        .filter(([name]) => !domain || name === domain)
        .map(([, catalog]) => catalog),
    );
    // Internal surface (ADR-0008): cacheable by the browser only, never by a shared cache.
    reply.header('cache-control', 'private, max-age=300');
    return { enums };
  });
}
