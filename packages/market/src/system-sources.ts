import { SYSTEM_ACTOR } from '@aptamind/contracts';
import type { CreateSourceInput, SourceService } from './sources/source.service';

/**
 * Built-in sources. Operator corrections and Aptamind's own discovery are modelled as
 * sources too, so their contributions carry provenance and authority like any other.
 */
export const SYSTEM_SOURCES: CreateSourceInput[] = [
  {
    key: 'system:operator',
    name: 'Operator decisions',
    category: 'manual_import',
    provider: 'operator',
    acquisition: { workflowKey: 'market.noop' },
    freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 525_600 },
    authority: { tier: 'operator', authoritativeFor: ['operator corrections'] },
    governance: { accessMethod: 'internal' },
    enabled: true,
  },
  {
    key: 'system:careers-discovery',
    name: 'Careers & ATS discovery',
    category: 'company_universe',
    provider: 'careers_discovery',
    acquisition: { workflowKey: 'market.careers_discovery.batch', config: { limit: 25 } },
    // Hourly, 25 companies per run (OPS-1): companies with a domain, never tried or tried > 30 days ago.
    schedule: { intervalMinutes: 60, timezone: 'UTC' },
    freshness: { policyClass: 'company.careers', maxAgeMinutes: 14 * 24 * 60 },
    authority: { tier: 'official_site', authoritativeFor: ['careers URL', 'ATS board'] },
    governance: {
      accessMethod: 'public_web',
      crawlPolicy: 'homepage + up to 6 careers candidates per company; host-scoped',
    },
    enabled: true,
  },
];

/** Set once a system source has had its built-in schedule, so later boots leave it alone. */
export const SCHEDULE_SEEDED_LABEL = 'system-schedule-seeded';

export async function ensureSystemSources(sources: SourceService): Promise<void> {
  for (const s of SYSTEM_SOURCES) {
    const seeded = s.schedule ? { ...s, labels: { ...s.labels, [SCHEDULE_SEEDED_LABEL]: 'true' } } : s;
    const { source, created } = await sources.register(seeded, SYSTEM_ACTOR);
    if (created || !s.schedule || source.labels[SCHEDULE_SEEDED_LABEL]) continue;
    // A system source registered before it had a schedule gets it once. After that the marker
    // stops a boot from putting back a schedule that an operator removed.
    await sources.update(
      source._id,
      {
        ...(source.schedule ? {} : { schedule: s.schedule }),
        labels: { ...source.labels, [SCHEDULE_SEEDED_LABEL]: 'true' },
      },
      SYSTEM_ACTOR,
    );
  }
}
