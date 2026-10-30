import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jobObservationPayloadSchema } from '../contracts/observations';
import { greenhouseAdapter } from './greenhouse';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../fixtures/ats/greenhouse/${name}`, import.meta.url), 'utf8'));

const ctx = { boardToken: 'acme' };

describe('greenhouseAdapter', () => {
  it('builds provider API URLs', () => {
    expect(greenhouseAdapter.listingUrl('acme')).toBe(
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true',
    );
    expect(greenhouseAdapter.jobUrl('acme', '4012345001')).toBe(
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345001?pay_transparency=true',
    );
  });

  it('maps a listing and skips the malformed entry with a warning', () => {
    const listing = greenhouseAdapter.parseListing(fixture('acme-listing-t1.json'), ctx);
    // 1 of 6 entries malformed (> 10 %): the board is not reliably readable, so not complete.
    expect(listing.complete).toBe(false);
    expect(listing.skipped).toEqual([
      {
        externalId: '4012345099',
        kind: 'malformed',
        locator: '/jobs/5',
        reason: expect.stringMatching(/^skipped malformed job \(id 4012345099\): title/),
      },
    ]);
    expect(listing.jobs.map((j) => j.payload.externalId)).toEqual([
      '4012345001',
      '4012345002',
      '4012345003',
      '4012345004',
      '4012345005',
    ]);
    expect(listing.jobs.map((j) => j.locator)).toEqual([
      '/jobs/0',
      '/jobs/1',
      '/jobs/2',
      '/jobs/3',
      '/jobs/4',
    ]);
    expect(listing.warnings).toEqual([
      expect.stringMatching(/^\/jobs\/5: skipped malformed job \(id 4012345099\)/),
      '1/6 entries malformed (> 10 %); listing treated as incomplete',
    ]);
    for (const job of listing.jobs)
      expect(() => jobObservationPayloadSchema.parse(job.payload)).not.toThrow();
  });

  it('maps fields, decodes entity-encoded content and reads pay ranges', () => {
    const [backend] = greenhouseAdapter.parseListing(fixture('acme-listing-t1.json'), ctx).jobs;
    const p = backend!.payload;
    expect(p).toMatchObject({
      externalId: '4012345001',
      requisitionId: 'ENG-104',
      title: 'Senior Backend Engineer',
      companyName: 'Acme',
      locations: [{ text: 'Remote', kind: 'job' }],
      workplaceType: null,
      employmentTypeText: 'Full-time',
      department: 'Engineering',
      postingUrl: 'https://job-boards.greenhouse.io/acme/jobs/4012345001',
      publishedAt: '2026-08-20T13:00:00.000Z',
      sourceUpdatedAt: '2026-09-01T14:15:22.000Z',
      compensation: { min: 150000, max: 190000, currency: 'USD', period: 'year' },
      provider: { name: 'greenhouse', boardToken: 'acme' },
    });
    expect(p.descriptionHtml).toContain('<h3>The role</h3>');
    expect(p.descriptionHtml).not.toContain('&lt;');
    expect(p.descriptionHtml).toContain('We&rsquo;re looking');
    expect(p.descriptionText).toContain('candidates must be located in the United States');
    expect(p.descriptionText).toContain('- Mentor engineers & lead technical design reviews');
    expect(p.descriptionText).not.toMatch(/<[a-z]/);
    expect(p.compensation?.text).toContain('US base salary: 150,000 - 190,000 USD');
  });

  it('keeps sponsorship text and reads workplace type from metadata', () => {
    const jobs = greenhouseAdapter.parseListing(fixture('acme-listing-t1.json'), ctx).jobs;
    const designer = jobs.find((j) => j.payload.externalId === '4012345003')!.payload;
    expect(designer.workplaceType).toBe('hybrid');
    expect(designer.descriptionText).toContain('we are unable to sponsor visas for this role');
    expect(designer.compensation).toBeNull();
    const emea = jobs.find((j) => j.payload.externalId === '4012345002')!.payload;
    expect(emea.locations).toEqual([{ text: 'Remote - EMEA', kind: 'job' }]);
  });

  it('reflects removed, changed and added jobs between snapshots', () => {
    const t1 = greenhouseAdapter.parseListing(fixture('acme-listing-t1.json'), ctx);
    const t2 = greenhouseAdapter.parseListing(fixture('acme-listing-t2.json'), ctx);
    const ids = (l: typeof t1) => new Set(l.jobs.map((j) => j.payload.externalId));
    expect([...ids(t1)].filter((id) => !ids(t2).has(id))).toEqual(['4012345005']);
    expect([...ids(t2)].filter((id) => !ids(t1).has(id))).toEqual(['4012345006']);
    const before = t1.jobs.find((j) => j.payload.externalId === '4012345003')!.payload;
    const after = t2.jobs.find((j) => j.payload.externalId === '4012345003')!.payload;
    expect(after.descriptionHtml).not.toBe(before.descriptionHtml);
    expect(after.sourceUpdatedAt).not.toBe(before.sourceUpdatedAt);
    expect(t2.warnings).toEqual([]);
  });

  it('marks the listing incomplete when meta.total disagrees', () => {
    const raw = fixture('acme-listing-t2.json') as { jobs: unknown[]; meta: { total: number } };
    const listing = greenhouseAdapter.parseListing({ ...raw, meta: { total: 40 } }, ctx);
    expect(listing.complete).toBe(false);
    expect(listing.warnings.join()).toMatch(/meta.total/);
  });

  it('throws on an unexpected top-level shape', () => {
    expect(() => greenhouseAdapter.parseListing({ status: 404, error: 'Not found' }, ctx)).toThrow(
      /not a \{ jobs/,
    );
    expect(() => greenhouseAdapter.parseListing([], ctx)).toThrow();
  });

  it('interprets single-job checks', () => {
    const check = { boardToken: 'acme', externalId: '4012345001' };
    const live = greenhouseAdapter.parseJobCheck(200, fixture('acme-job-4012345001.json'), check);
    expect(live.outcome).toBe('live');
    expect(live.payload?.title).toBe('Senior Backend Engineer');
    expect(greenhouseAdapter.parseJobCheck(404, fixture('job-not-found.json'), check)).toEqual({
      outcome: 'not_found',
    });
    expect(greenhouseAdapter.parseJobCheck(503, null, check).outcome).toBe('unknown');
    expect(greenhouseAdapter.parseJobCheck(200, { unexpected: true }, check).outcome).toBe('unknown');
    expect(
      greenhouseAdapter.parseJobCheck(200, fixture('acme-job-4012345001.json'), { ...check, externalId: '1' })
        .outcome,
    ).toBe('unknown');
  });

  describe('PR #11 A-H1 audit: only a 404/410 from the job endpoint is not_found', () => {
    const check = (status: number, raw: unknown) =>
      greenhouseAdapter.parseJobCheck(status, raw, { boardToken: 'acme', externalId: '7' }).outcome;
    it.each([
      [200, null],
      [200, 'not json'],
      [200, {}],
      [200, { id: 'other', title: 'x', text: 'x' }],
      [301, null],
      [403, null],
      [429, null],
      [500, null],
      [503, null],
    ])('HTTP %s with %j → unknown', (status, raw) => {
      expect(check(status, raw)).toBe('unknown');
    });
    it('404 and 410 → not_found; the job itself → live', () => {
      expect(check(404, null)).toBe('not_found');
      expect(check(410, null)).toBe('not_found');
      expect(check(200, { id: 7, title: 'Engineer' })).toBe('live');
    });
  });
});
