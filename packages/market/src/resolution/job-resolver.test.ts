import { describe, expect, it } from 'vitest';
import { shingles } from '../jobs/fingerprint';
import { type JobCandidate, type JobLookup, type JobSummary, resolveJobCandidate } from './job-resolver';

const desc =
  'Build and operate our payments platform in Go. Own services end to end, partner with product, and mentor engineers across the backend team.';
const other =
  'Plan and run integrated marketing campaigns across EMEA, owning the budget and brand strategy for our enterprise segment.';

function job(id: string, extra: Partial<JobSummary> = {}): JobSummary {
  return {
    id,
    companyId: 'cmp',
    state: 'VERIFIED_LIVE',
    requisitionId: null,
    titleKey: 'senior backend engineer',
    locationKey: 'london uk',
    shingles: shingles(desc),
    sourceIds: ['src_gh'],
    presentSourceIds: ['src_gh'],
    distinctFrom: [],
    ...extra,
  };
}

function lookup(jobs: Array<JobSummary & { keys?: string[]; urls?: string[] }>): JobLookup {
  return {
    bySourceKey: async (k) => jobs.find((j) => j.keys?.includes(k)) ?? null,
    byUrlFingerprints: async (fps) => jobs.filter((j) => j.urls?.some((u) => fps.includes(u))),
    byRequisition: async (_c, r) => jobs.filter((j) => j.requisitionId === r),
    byCompanyTitle: async (_c, t) => jobs.filter((j) => j.titleKey === t),
  };
}

const cand = (extra: Partial<JobCandidate> = {}): JobCandidate => ({
  sourceId: 'src_agg',
  sourceKey: 'src_agg:1',
  companyId: 'cmp',
  requisitionId: null,
  titleKey: 'senior backend engineer',
  locationKey: 'london uk',
  urlFingerprints: [],
  shingles: shingles(desc),
  ...extra,
});

describe('job resolution', () => {
  it('reuses the job for the same source record', async () => {
    const d = await resolveJobCandidate(
      cand({ sourceId: 'src_gh', sourceKey: 'src_gh:1' }),
      lookup([{ ...job('job_1'), keys: ['src_gh:1'] }]),
    );
    expect(d).toMatchObject({ kind: 'existing', relation: 'same_source' });
  });

  it('resolves syndicated copies by URL and by content', async () => {
    expect(
      await resolveJobCandidate(
        cand({ urlFingerprints: ['boards.greenhouse.io/acme/jobs/1'] }),
        lookup([{ ...job('job_1'), urls: ['boards.greenhouse.io/acme/jobs/1'] }]),
      ),
    ).toMatchObject({
      kind: 'existing',
      relation: 'syndicated',
      method: 'url_fingerprint',
    });
    expect(await resolveJobCandidate(cand(), lookup([job('job_1')]))).toMatchObject({
      kind: 'existing',
      relation: 'syndicated',
    });
  });

  it('keeps same requisition in a different location distinct', async () => {
    const d = await resolveJobCandidate(
      cand({ requisitionId: 'R-1', locationKey: 'berlin germany' }),
      lookup([job('job_1', { requisitionId: 'R-1' })]),
    );
    expect(d).toMatchObject({ kind: 'new', relatedJobIds: ['job_1'] });
  });

  it('detects reposts of closed jobs', async () => {
    const d = await resolveJobCandidate(
      cand({ sourceId: 'src_gh', sourceKey: 'src_gh:2' }),
      lookup([job('job_1', { state: 'CLOSED', presentSourceIds: [] })]),
    );
    expect(d).toMatchObject({ kind: 'existing', relation: 'repost' });
  });

  it('treats two live openings with the same title on one board as distinct', async () => {
    const d = await resolveJobCandidate(
      cand({ sourceId: 'src_gh', sourceKey: 'src_gh:2' }),
      lookup([job('job_1')]),
    );
    expect(d.kind).toBe('new');
  });

  it('flags uncertain duplicates for review without merging', async () => {
    const partial = `${desc.split(' ').slice(0, 14).join(' ')} ${other}`;
    const d = await resolveJobCandidate(cand({ shingles: shingles(partial) }), lookup([job('job_1')]));
    expect(d.kind).toBe('new');
  });

  it('does not match different locations', async () => {
    expect(
      (await resolveJobCandidate(cand({ locationKey: 'new york us' }), lookup([job('job_1')]))).kind,
    ).toBe('new');
  });
});
