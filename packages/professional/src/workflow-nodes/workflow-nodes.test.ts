import { describe, expect, it } from 'vitest';
import { TerminalError } from '@aptamind/workflow-sdk';
import { DATA_CLASSES } from '../subjects/subject.schema';
import { isProcessableDataClass, loadSnapshot, PROCESSABLE_DATA_CLASSES } from './index';

/** A capability context whose Professional service returns this subject (dependency injection). */
function ctxWith(dataClass: string) {
  const ids = { subjectId: 'psub_nodes01', sourceId: 'psrc_nodes01', snapshotId: 'psnap_nodes01' };
  const domain = {
    snapshots: {
      col: { findOne: async () => ({ _id: ids.snapshotId, ...ids, via: 'form' }) },
    },
    sources: { get: async () => ({ _id: ids.sourceId, kind: 'questionnaire' }) },
    subjects: { get: async () => ({ _id: ids.subjectId, status: 'active', consent: { dataClass } }) },
  };
  return { ctx: { services: { get: () => domain } } as never, input: ids };
}

describe('processable data classes (P1.3 re-verify nit)', () => {
  it('every data class the schema accepts today is explicitly processable', () => {
    // A new data class fails here until someone decides whether it is processable.
    expect([...PROCESSABLE_DATA_CLASSES].sort()).toEqual([...DATA_CLASSES].sort());
  });

  it('a data class outside the allowlist is refused (hypothetical class, injected allowlist)', () => {
    expect(isProcessableDataClass('third_party_public')).toBe(false);
    expect(isProcessableDataClass('synthetic', ['owner_consented'])).toBe(false);
    expect(isProcessableDataClass('owner_consented', ['owner_consented'])).toBe(true);
  });

  it('load_snapshot refuses a subject whose data class is not processable, and loads one that is', async () => {
    const refused = ctxWith('third_party_public');
    const err = await loadSnapshot.execute(refused.ctx, refused.input, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect((err as Error).message).toBe('consent_required');
    const ok = ctxWith('synthetic');
    await expect(loadSnapshot.execute(ok.ctx, ok.input, {})).resolves.toMatchObject({
      snapshotId: 'psnap_nodes01',
      sourceKind: 'questionnaire',
    });
  });
});
