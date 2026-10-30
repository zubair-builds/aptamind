import type { Db } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@aptamind/contracts';
import { createLogger } from '@aptamind/observability';
import type { ArtifactStore } from '@aptamind/storage';
import { DEFAULT_PROFESSIONAL_LIMITS } from '../context';
import { ProfessionalDomain } from '../professional-domain';
import {
  hasProfessionalArtifactLabel,
  isProfessionalWorkflowKey,
  PROFESSIONAL_ARTIFACT_LABELS,
} from './artifacts';

/** A fake Db whose snapshot/extraction lookups are scripted per collection. */
function fakeDb(findOne: (collection: string) => Promise<unknown>): Db {
  return {
    collection: (name: string) => ({ findOne: () => findOne(name) }),
  } as unknown as Db;
}

function domain(db: Db) {
  return new ProfessionalDomain({
    db,
    clock: new FixedClock(new Date('2026-09-29T00:00:00Z')),
    logger: createLogger({ service: 'professional-test', level: 'silent' }),
    artifacts: {} as ArtifactStore,
    config: { aiModel: 'fixture-model', limits: { ...DEFAULT_PROFESSIONAL_LIMITS } },
  });
}

describe('Professional artifact label (FE-P6)', () => {
  it('recognizes only the Professional domain label', () => {
    expect(hasProfessionalArtifactLabel(PROFESSIONAL_ARTIFACT_LABELS)).toBe(true);
    expect(hasProfessionalArtifactLabel({ domain: 'professional', sourceId: 'psrc_1' })).toBe(true);
    const others: Array<Record<string, string> | undefined> = [
      undefined,
      {},
      { domain: 'market' },
      { sourceId: 'src_1' },
      { domain: 'Professional' },
    ];
    for (const labels of others) expect(hasProfessionalArtifactLabel(labels)).toBe(false);
    expect(Object.isFrozen(PROFESSIONAL_ARTIFACT_LABELS)).toBe(true);
  });

  it('recognizes Professional workflow keys by prefix only', () => {
    expect(isProfessionalWorkflowKey('professional.source.ingest')).toBe(true);
    for (const key of [
      undefined,
      '',
      'professional',
      'market.ingest',
      'x.professional.y',
      'Professional.a',
    ]) {
      expect(isProfessionalWorkflowKey(key)).toBe(false);
    }
  });
});

describe('ProfessionalDomain.ownsArtifact (FE-P6)', () => {
  it('owns labelled and Professional-workflow artifacts without a lookup', async () => {
    const d = domain(
      fakeDb(async () => {
        throw new Error('must not query');
      }),
    );
    expect(await d.ownsArtifact({ _id: 'art_1', context: { labels: { domain: 'professional' } } })).toBe(
      true,
    );
    expect(
      await d.ownsArtifact({ _id: 'art_2', context: { workflowKey: 'professional.source.ingest' } }),
    ).toBe(true);
  });

  it('owns an artifact referenced by a snapshot or an extraction, and nothing else', async () => {
    const none = fakeDb(async () => null);
    expect(await domain(none).ownsArtifact({ _id: 'art_1', context: { workflowKey: 'market.ingest' } })).toBe(
      false,
    );
    for (const hit of ['professional_snapshots', 'professional_extractions']) {
      const db = fakeDb(async (c) => (c === hit ? { _id: 'x' } : null));
      expect(await domain(db).ownsArtifact({ _id: 'art_1' })).toBe(true);
    }
  });

  it('fails closed: rejects when either reference lookup fails', async () => {
    for (const failing of ['professional_snapshots', 'professional_extractions']) {
      const db = fakeDb(async (c) => {
        if (c === failing) throw new Error('db down');
        return null;
      });
      await expect(domain(db).ownsArtifact({ _id: 'art_1' })).rejects.toThrow('db down');
    }
  });
});
