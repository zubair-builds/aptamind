import { describe, expect, it } from 'vitest';
import { inputFromStoredCopy } from '../enrichment/golden';
import { interpretJob } from '../enrichment/interpret';

const payload = {
  title: 'Customer Success Manager',
  locations: [{ text: 'Berlin, Germany' }],
  department: 'Customer Success',
  workplaceType: 'hybrid' as const,
  employmentTypeText: 'Full-time',
  compensation: { text: '€60k', min: 60000, max: null, currency: 'EUR', period: 'year' as const },
  descriptionText: '  Plain text wins.  ',
  descriptionHtml: '<p>HTML only when there is no text.</p>',
};

describe('interpretationInput (the one input of reconciliation and market.interpret_job)', () => {
  it('carries the provider fields, including the department', () => {
    expect(inputFromStoredCopy({ payload, company: null })).toEqual({
      title: 'Customer Success Manager',
      descriptionText: 'Plain text wins.',
      // HTML present: statements are read from its canonical layout rendering (a720377 (1)).
      statementSource: {
        rendering: 'html_layout',
        text: 'HTML only when there is no text.',
        layoutLineStarts: [],
      },
      locationTexts: ['Berlin, Germany'],
      provider: {
        workplaceType: 'hybrid',
        employmentTypeText: 'Full-time',
        department: 'Customer Success',
        compensation: payload.compensation,
      },
      company: null,
    });
  });

  it('statements are read from the HTML layout rendering whenever HTML exists, whatever descriptionText says (a720377 (1))', () => {
    const html = '<p>Join us.</p><table><tr><td>Visa sponsorship:</td><td>No</td></tr></table>';
    const input = inputFromStoredCopy({
      // A connector-rendered text joins the cells without a separator.
      payload: { ...payload, descriptionText: 'Join us.\n\nVisa sponsorship:No', descriptionHtml: html },
      company: null,
    });
    expect(input.descriptionText).toBe('Join us.\n\nVisa sponsorship:No');
    expect(input.statementSource).toEqual({
      rendering: 'html_layout',
      text: 'Join us.\n\nVisa sponsorship: No',
      layoutLineStarts: [10],
    });
    // Without HTML, descriptionText itself (and it says so).
    const plain = inputFromStoredCopy({
      payload: { ...payload, descriptionText: 'Visa sponsorship: No', descriptionHtml: undefined },
      company: null,
    });
    expect(plain.statementSource).toEqual({
      rendering: 'description_text',
      text: 'Visa sponsorship: No',
      layoutLineStarts: [],
    });
    // A tagless "descriptionHtml" (aggregator / JSON-LD plain text) is text, newlines kept (5a13fed).
    const tagless = inputFromStoredCopy({
      payload: {
        ...payload,
        descriptionHtml: 'US applicants\nVisa sponsorship: No\nUK applicants\nVisa sponsorship: Yes',
        descriptionText: 'US applicants\nVisa sponsorship: No\nUK applicants\nVisa sponsorship: Yes',
      },
      company: null,
    });
    expect(tagless.statementSource?.rendering).toBe('description_text');
    expect(tagless.statementSource?.text.split('\n')).toHaveLength(4);
  });

  it('the 200k statement cap drops a partial last line (7f01fe5 L2)', () => {
    const stated = (input: ReturnType<typeof inputFromStoredCopy>) =>
      interpretJob(input).flags.filter((f) => f.code === 'sponsorship_stated');
    // The cap falls inside "Visa sponsorship: Not available", right after "No".
    const plain = `${'a'.repeat(199_979)}\nVisa sponsorship: Not available`;
    const fromText = inputFromStoredCopy({
      payload: { ...payload, descriptionText: plain, descriptionHtml: undefined },
      company: null,
    });
    expect(fromText.descriptionText.endsWith('Visa sponsorship: No')).toBe(true);
    expect(fromText.statementSource?.text).not.toContain('Visa');
    expect(stated(fromText)).toEqual([]);
    const fromHtml = inputFromStoredCopy({
      payload: {
        ...payload,
        descriptionText: '',
        descriptionHtml: `<p>${'a'.repeat(199_978)}</p><p>Visa sponsorship: Not available</p>`,
      },
      company: null,
    });
    expect(fromHtml.statementSource?.text).not.toContain('Visa');
    expect(stated(fromHtml)).toEqual([]);
  });

  it('a text of exactly 200k characters keeps its complete last line (bc013e8 L3)', () => {
    const exact = `${'a'.repeat(199_979)}\nVisa sponsorship: No`;
    expect(exact.length).toBe(200_000);
    const input = inputFromStoredCopy({
      payload: { ...payload, descriptionText: exact, descriptionHtml: undefined },
      company: null,
    });
    expect(input.statementSource?.text).toBe(exact);
    expect(interpretJob(input).flags.find((f) => f.code === 'sponsorship_stated')?.value).toBe('no');
  });

  it('passes current licences, lapsed licences (deduplicated, as past capability — not history) and the HQ country', () => {
    const input = inputFromStoredCopy({
      payload,
      company: { licenceCountries: ['IE'], lapsedLicenceCountries: ['GB', 'GB', 'NL'], hqCountry: 'GB' },
    });
    expect(input.company).toEqual({
      sponsorLicenceCountries: ['IE'],
      historicalSponsorshipCountries: [],
      previousLicenceCountries: ['GB', 'NL'],
      hqCountry: 'GB',
    });
  });

  it('renders HTML when the copy has no plain text, and defaults missing provider fields to null', () => {
    const input = inputFromStoredCopy({
      payload: { title: 'X', locations: [], descriptionHtml: '<p>From <b>HTML</b></p>' },
      company: { hqCountry: null },
    });
    expect(input.descriptionText).toBe('From HTML');
    expect(input.provider).toEqual({
      workplaceType: null,
      employmentTypeText: null,
      department: null,
      compensation: null,
    });
    expect(input.company).toEqual({
      sponsorLicenceCountries: [],
      historicalSponsorshipCountries: [],
      previousLicenceCountries: [],
      hqCountry: null,
    });
  });
});
