import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jobObservationPayloadSchema } from '../contracts/observations';
import { ashbyAdapter } from './ashby';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../fixtures/ats/ashby/${name}`, import.meta.url), 'utf8'));

const ctx = { boardToken: 'gamma' };
const id = (n: string) => `3b0f5a52-8f1e-4c63-9d1c-1a2b3c4d5e${n}`;

describe('ashbyAdapter', () => {
  it('uses the listing endpoint for job checks', () => {
    const url = 'https://api.ashbyhq.com/posting-api/job-board/gamma?includeCompensation=true';
    expect(ashbyAdapter.listingUrl('gamma')).toBe(url);
    expect(ashbyAdapter.jobUrl('gamma', id('01'))).toBe(url);
  });

  it('maps listed jobs and skips unlisted and malformed entries', () => {
    const listing = ashbyAdapter.parseListing(fixture('gamma-job-board.json'), ctx);
    expect(listing.complete).toBe(false); // 1 of 6 malformed (> 10 %); unlisted does not count
    expect(listing.jobs.map((j) => j.payload.externalId)).toEqual([id('01'), id('02'), id('03'), id('04')]);
    expect(listing.skipped).toEqual([
      { externalId: id('05'), kind: 'unlisted', locator: '/jobs/4', reason: 'unlisted' },
      expect.objectContaining({ externalId: id('99'), kind: 'malformed', locator: '/jobs/5' }),
    ]);
    // Unlisted is a provider state, not a parser warning.
    expect(listing.warnings).toEqual([
      expect.stringMatching(/^\/jobs\/5: skipped malformed job \(id .*e99\): title/),
      '1/5 entries malformed (> 10 %); listing treated as incomplete', // A-L4: unlisted not counted
    ]);
    for (const job of listing.jobs)
      expect(() => jobObservationPayloadSchema.parse(job.payload)).not.toThrow();
  });

  it('maps fields and the salary component of compensation', () => {
    const [ml] = ashbyAdapter.parseListing(fixture('gamma-job-board.json'), ctx).jobs;
    expect(ml!.payload).toMatchObject({
      externalId: id('01'),
      title: 'Senior ML Engineer',
      department: 'Engineering',
      team: 'Applied ML',
      employmentTypeText: 'Full-time',
      workplaceType: 'remote',
      locations: [{ text: 'Remote', kind: 'job' }],
      postingUrl: `https://jobs.ashbyhq.com/gamma/${id('01')}`,
      applyUrl: `https://jobs.ashbyhq.com/gamma/${id('01')}/application`,
      publishedAt: '2026-09-08T14:03:21.118Z',
      compensation: {
        text: '$180K – $230K • Offers Equity',
        min: 180000,
        max: 230000,
        currency: 'USD',
        period: 'year',
      },
      provider: { name: 'ashby', boardToken: 'gamma' },
    });
    expect(ml!.payload.descriptionText).toContain('Remote (US only)');
  });

  it('maps secondary locations, workplace flags and hourly pay', () => {
    const jobs = ashbyAdapter.parseListing(fixture('gamma-job-board.json'), ctx).jobs.map((j) => j.payload);
    const emea = jobs.find((j) => j.externalId === id('02'))!;
    expect(emea.locations.map((l) => l.text)).toEqual(['Remote - Europe', 'Dublin, Ireland', 'Remote - UK']);
    expect(emea.compensation).toMatchObject({ currency: 'EUR', period: 'year' });
    const designer = jobs.find((j) => j.externalId === id('03'))!;
    expect(designer.workplaceType).toBe('hybrid');
    expect(designer.locations).toEqual([
      { text: 'San Francisco, CA', kind: 'job', city: 'San Francisco', region: 'California' },
    ]);
    expect(designer.descriptionText).toContain('unable to sponsor visas');
    expect(designer.compensation).toBeNull();
    const intern = jobs.find((j) => j.externalId === id('04'))!;
    expect(intern).toMatchObject({ workplaceType: 'onsite', employmentTypeText: 'Intern' });
    expect(intern.compensation).toMatchObject({ min: 45, max: 55, period: 'hour' });
  });

  it('falls back to isRemote when workplaceType is absent', () => {
    const raw = {
      jobs: [{ id: 'x1', title: 'Engineer', isListed: true, isRemote: true, location: 'Remote' }],
    };
    expect(ashbyAdapter.parseListing(raw, ctx).jobs[0]?.payload.workplaceType).toBe('remote');
  });

  it('throws on an unexpected top-level shape', () => {
    expect(() => ashbyAdapter.parseListing({ success: false }, ctx)).toThrow(/not a \{ jobs/);
  });

  it('checks a job against the complete listing', () => {
    const raw = fixture('gamma-job-board.json');
    const live = ashbyAdapter.parseJobCheck(200, raw, { boardToken: 'gamma', externalId: id('02') });
    expect(live.outcome).toBe('live');
    expect(live.payload?.title).toBe('Solutions Engineer, EMEA');
    // The fixture board is incomplete (1 of 6 entries malformed): absence proves nothing there.
    expect(ashbyAdapter.parseJobCheck(200, raw, { boardToken: 'gamma', externalId: 'gone' }).outcome).toBe(
      'unknown',
    );
    const clean = {
      jobs: [
        { id: id('01'), title: 'Senior ML Engineer' },
        { id: id('02'), title: 'Other' },
      ],
    };
    expect(ashbyAdapter.parseJobCheck(200, clean, { boardToken: 'gamma', externalId: 'gone' }).outcome).toBe(
      'not_found',
    );
    expect(ashbyAdapter.parseJobCheck(200, raw, { boardToken: 'gamma', externalId: id('05') }).outcome).toBe(
      'unknown',
    );
    expect(ashbyAdapter.parseJobCheck(404, null, { boardToken: 'gamma', externalId: id('01') }).outcome).toBe(
      'unknown',
    );
    expect(
      ashbyAdapter.parseJobCheck(200, 'oops', { boardToken: 'gamma', externalId: id('01') }).outcome,
    ).toBe('unknown');
  });

  describe('PR #11 A-H1: not_found needs a readable, complete board', () => {
    const check = (raw: unknown, externalId = 'a1') =>
      ashbyAdapter.parseJobCheck(200, raw, { boardToken: 'gamma', externalId }).outcome;
    const ok = (i: string) => ({ id: i, title: `Job ${i}` });
    it.each([
      [
        'every entry malformed (shape drift)',
        {
          jobs: [
            { id: 'b1', name: 'x' },
            { id: 'b2', name: 'y' },
          ],
        },
      ],
      ['an id-less malformed entry', { jobs: [ok('b1'), ok('b2'), { title: 'no id' }] }],
      ['> 10 % malformed', { jobs: [ok('b1'), { id: 'b2', title: '' }] }],
      ['the job present with a numeric id', { jobs: [{ id: 1, title: 'x' }, ok('b2')] }],
      ['the job unlisted', { jobs: [{ ...ok('a1'), isListed: false }, ok('b2')] }],
      [
        'the job malformed',
        { jobs: [{ id: 'a1', title: '' }, ...Array.from({ length: 10 }, (_, i) => ok(`c${i}`))] },
      ],
      ['top-level key renamed', { postings: [ok('b1')] }],
      ['not JSON', null],
    ])('%s → unknown', (_label, raw) => {
      expect(check(raw)).toBe('unknown');
    });

    it('an empty board is a not_found with boardEntries 0: the caller gates it against the baseline', () => {
      expect(
        ashbyAdapter.parseJobCheck(200, { jobs: [] }, { boardToken: 'gamma', externalId: 'a1' }),
      ).toEqual({
        outcome: 'not_found',
        boardEntries: 0,
      });
    });

    it('a complete, readable board without the job → not_found; with it → live', () => {
      expect(check({ jobs: [ok('b1'), ok('b2')] })).toBe('not_found');
      expect(check({ jobs: [ok('a1'), ok('b2')] })).toBe('live');
    });
  });
});
