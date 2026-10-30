import type { Db } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@aptamind/contracts';
import { createLogger } from '@aptamind/observability';
import type { ArtifactStore } from '@aptamind/storage';
import { ServiceRegistry } from '@aptamind/workflow-sdk';
import {
  createProfessionalDomain,
  DEFAULT_PROFESSIONAL_LIMITS,
  PROFESSIONAL,
  type ProfessionalContext,
  ProfessionalDomain,
  professionalCapabilities,
  professionalWorkflows,
} from './index';

function ctx(): ProfessionalContext {
  return {
    db: { collection: () => ({}) } as unknown as Db,
    clock: new FixedClock(new Date('2026-09-29T00:00:00Z')),
    logger: createLogger({ service: 'professional-test', level: 'silent' }),
    artifacts: {} as ArtifactStore,
    config: { aiModel: 'fixture-model', limits: { ...DEFAULT_PROFESSIONAL_LIMITS } },
  };
}

describe('ProfessionalDomain facade', () => {
  it('is created from its context and ports, and exposes them unchanged', () => {
    const c = ctx();
    const launcher = {
      startRun: async () => ({
        _id: 'run_1',
        state: 'PENDING',
        workflowKey: 'professional.source.ingest',
        input: {},
      }),
    };
    const resumer = { resumeByCorrelationKey: async () => 0 };
    const domain = createProfessionalDomain(c, { launcher, resumer });
    expect(domain).toBeInstanceOf(ProfessionalDomain);
    expect(domain.ctx).toBe(c);
    expect(domain.ctx.config.aiModel).toBe('fixture-model');
    expect(domain.launcher).toBe(launcher);
    expect(domain.resumer).toBe(resumer);
    expect(createProfessionalDomain(c).launcher).toBeUndefined();
  });

  it('registers under its own namespaced service token', () => {
    expect(PROFESSIONAL.key).toBe('professional.domain');
    const domain = createProfessionalDomain(ctx());
    const services = new ServiceRegistry().register(PROFESSIONAL, domain);
    expect(services.get(PROFESSIONAL)).toBe(domain);
  });

  it('contributes only professional.* capabilities and workflows', () => {
    for (const c of professionalCapabilities) expect(c.type).toMatch(/^professional\./);
    for (const w of professionalWorkflows) expect(w.key).toMatch(/^professional\./);
  });

  it('ships frozen default limits', () => {
    expect(Object.isFrozen(DEFAULT_PROFESSIONAL_LIMITS)).toBe(true);
    expect(DEFAULT_PROFESSIONAL_LIMITS.maxUploadBytes).toBeGreaterThan(0);
    expect(DEFAULT_PROFESSIONAL_LIMITS.maxDocumentPages).toBeGreaterThan(0);
  });
});
