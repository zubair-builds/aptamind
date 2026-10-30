import { describe, expect, it } from 'vitest';
import { findRegisterCsvLink, sponsorRowToPayload } from './uk-sponsor-register';

describe('UK sponsor register mapping', () => {
  it('maps a row to company capability evidence (not job sponsorship)', () => {
    const r = sponsorRowToPayload({
      name: 'Acme Ltd t/a Acme Coffee',
      town: 'LONDON',
      county: 'Greater London',
      typeRating: 'Worker (A rating)',
      route: 'Skilled Worker',
    });
    expect(r?.payload).toMatchObject({
      name: 'Acme Ltd t/a Acme Coffee',
      legalName: 'Acme Ltd',
      aliases: ['Acme Coffee'],
      externalIds: [{ namespace: 'uk_sponsor_register', id: 'acme ltd|london' }],
      locations: [{ city: 'London', country: 'GB', kind: 'registered' }],
      sponsorLicence: { country: 'GB', route: 'Skilled Worker', typeRating: 'Worker (A rating)' },
    });
    expect(r?.externalId).toBe('acme ltd|london|skilled worker');
  });

  it('rejects unusable rows', () => {
    expect(sponsorRowToPayload({ name: ' ', route: 'Skilled Worker' })).toBeNull();
    expect(sponsorRowToPayload({ name: 'X Ltd', route: '' })).toBeNull();
  });

  it('finds the CSV link on the publication page', () => {
    const html =
      '<a href="/foo.pdf">Guidance</a><a href="https://assets.publishing.service.gov.uk/media/abc/2026-09-27_-_Worker_and_Temporary_Worker.csv">Register of licensed sponsors: workers</a>';
    expect(findRegisterCsvLink(html, 'https://www.gov.uk/x')).toBe(
      'https://assets.publishing.service.gov.uk/media/abc/2026-09-27_-_Worker_and_Temporary_Worker.csv',
    );
  });
});
