import { describe, expect, it } from 'vitest';
import type { JobDoc, SourceRef } from '../jobs/job.schema';
import { latestListingFailed, verificationRef } from './verification.service';

const t = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
const ref = (over: Partial<SourceRef>): SourceRef =>
  ({
    key: `s:${over.externalId ?? 'x'}`,
    sourceId: 's',
    externalId: 'x',
    provider: 'ashby',
    authority: 'official_ats',
    firstSeenAt: t(0),
    lastSeenAt: t(1),
    present: true,
    ...over,
  }) as SourceRef;
const jobWith = (sourceRefs: SourceRef[], lifecycle: Partial<JobDoc['lifecycle']> = {}) =>
  ({
    sourceRefs,
    lifecycle: {
      lastSeenAt: t(2),
      lastVerifiedAt: t(2),
      absentSince: t(5),
      consecutiveAbsences: 2,
      ...lifecycle,
    },
  }) as unknown as JobDoc;

describe('DECISION_LOG a9af734: job-level absence and the verification reference', () => {
  const ats = ref({ externalId: 'a', authority: 'official_ats', present: false, lastSeenAt: t(3) });
  const site = ref({
    externalId: 'b',
    sourceId: 'site',
    provider: 'careers_page',
    authority: 'official_site',
    present: true,
    lastSeenAt: t(1),
  });
  const agg = ref({
    externalId: 'c',
    sourceId: 'agg',
    provider: 'aggregator',
    authority: 'third_party',
    present: true,
    lastSeenAt: t(9),
  });

  it('a present authoritative copy wins over an absent higher-ranked one', () => {
    expect(verificationRef(jobWith([ats, site]))?.sourceId).toBe('site');
    expect(verificationRef(jobWith([ats, agg]))?.sourceId).toBe('s'); // third-party never wins
  });

  it('LOW-1 (re-verify #7): an aggregator copy stored with an authoritative tier is third-party', () => {
    const mislabelled = ref({
      externalId: 'd',
      sourceId: 'agg2',
      provider: 'Aggregator',
      authority: 'official_ats',
      present: true,
      lastSeenAt: t(9),
    });
    expect(verificationRef(jobWith([ats, mislabelled]))?.sourceId).toBe('s');
  });
});

describe('latest listing failed (MEDIUM-2, LOW-D): the latest REAL acquisition decides', () => {
  const health = (h: Record<string, unknown>) =>
    ({ health: { status: 'healthy', consecutiveFailures: 0, ...h } }) as never;
  it('reads health.latestFetch when present, which reprocessing never moves', () => {
    expect(latestListingFailed(health({ latestFetch: { at: t(5), ok: false }, lastSuccessAt: t(9) }))).toBe(
      true,
    );
    expect(latestListingFailed(health({ latestFetch: { at: t(5), ok: true }, lastFailureAt: t(9) }))).toBe(
      false,
    );
  });
  it('falls back to failure-vs-success times for sources fetched before it existed', () => {
    expect(latestListingFailed(health({ lastFailureAt: t(5), lastSuccessAt: t(4) }))).toBe(true);
    expect(latestListingFailed(health({ lastFailureAt: t(3), lastSuccessAt: t(4) }))).toBe(false);
    expect(latestListingFailed(health({}))).toBe(false);
  });
});
