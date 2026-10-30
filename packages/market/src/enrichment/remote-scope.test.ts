import { describe, expect, it } from 'vitest';
import { normalizeLocations } from './locations';
import { findRemoteRestrictions, interpretRemoteScope } from './remote-scope';
import type { RemoteScopeInput } from './remote-scope';

function scope(description: string, extra: Partial<RemoteScopeInput> = {}) {
  const locationTexts = extra.locationTexts ?? ['Remote'];
  return interpretRemoteScope({
    workModel: extra.workModel ?? 'remote',
    workModelConfidence: extra.workModelConfidence ?? 'high',
    workModelEvidence: extra.workModelEvidence ?? [],
    title: extra.title ?? 'Engineer',
    description,
    locationTexts,
    locations: normalizeLocations(locationTexts),
  });
}

describe('country restrictions', () => {
  it.each([
    ['Candidates must be based in the United States.', ['US']],
    ['This role is US-only.', ['US']],
    ['You must reside in the U.S. to be considered.', ['US']],
    ['We can only hire in the UK.', ['GB']],
    ['Open to candidates in the US and Canada.', ['US', 'CA']],
    ['You can work remotely from anywhere in Germany.', ['DE']],
    ['We are looking for US-based candidates.', ['US']],
    ['You must live in California or Texas.', ['US']],
  ])('%s', (text, countries) => {
    const r = scope(text);
    expect(r.remoteScope.value.countries).toEqual(countries);
    expect(r.remoteScope.value.type).toBe(countries.length > 1 ? 'selected_countries' : 'country');
    expect(r.remoteScope.confidence).toBe('high');
    expect(r.remoteScope.evidence[0]?.quote).toBe(text);
  });

  it('flags a plain Remote label restricted by the body', () => {
    const r = scope('Must be based in the UK.');
    expect(r.flags).toEqual([
      expect.objectContaining({ code: 'remote_label_restricted', severity: 'warning' }),
    ]);
  });

  it('does not flag a label that already states the same scope', () => {
    const r = scope('Must be based in the US.', { locationTexts: ['Remote - US'] });
    expect(r.flags).toEqual([]);
  });

  it('ignores company facts that are not candidate restrictions', () => {
    const r = scope('We are a US-based company with offices in London and Berlin.');
    expect(r.remoteScope.value.type).toBe('unclear');
  });

  it('does not let a following clause leak into the restriction', () => {
    const r = scope('You must be based in the UK, and our HQ is in Berlin.');
    expect(r.remoteScope.value.countries).toEqual(['GB']);
  });
});

describe('regions, exclusions and timezones', () => {
  it('maps region restrictions', () => {
    expect(scope('This role is remote, EMEA only.').remoteScope.value).toMatchObject({
      type: 'region',
      regions: ['EMEA'],
    });
    expect(scope('Remote within the European Union.').remoteScope.value).toMatchObject({
      type: 'region',
      regions: ['EU'],
    });
    expect(scope('Open to applicants in LatAm.').remoteScope.value).toMatchObject({
      type: 'region',
      regions: ['LATAM'],
    });
  });

  it('collapses countries covered by a stated region', () => {
    const r = scope('You must be located in Europe (including the UK).');
    expect(r.remoteScope.value).toMatchObject({ type: 'region', regions: ['EUROPE'], countries: [] });
  });

  it('keeps countries outside the stated region as selected countries', () => {
    const r = scope('You must be based in Europe or the US.');
    expect(r.remoteScope.value).toMatchObject({
      type: 'selected_countries',
      regions: ['EUROPE'],
      countries: ['US'],
    });
  });

  it('records exclusions', () => {
    const r = scope('Remote anywhere in Europe except Russia.');
    expect(r.remoteScope.value).toMatchObject({
      type: 'region',
      regions: ['EUROPE'],
      excludedCountries: ['RU'],
    });
    const s = scope('We cannot hire in France or Italy.');
    expect(s.remoteScope.value).toMatchObject({ type: 'unclear', excludedCountries: ['FR', 'IT'] });
    expect(s.remoteScope.confidence).toBe('low');
  });

  it('parses timezone-only scopes', () => {
    const r = scope('Remote within UTC-3 to UTC+3.');
    expect(r.remoteScope.value).toMatchObject({
      type: 'timezone',
      timezone: { minUtcOffset: -3, maxUtcOffset: 3, text: 'UTC-3 to UTC+3' },
    });
    const overlap = scope('You must overlap 4 hours with CET.');
    expect(overlap.remoteScope.value.timezone).toMatchObject({ minUtcOffset: -3, maxUtcOffset: 5 });
    const plain = scope('Overlap with CET business hours is expected.');
    expect(plain.remoteScope.confidence).toBe('medium');
  });

  it('attaches timezones to country scopes', () => {
    const r = scope('You must be based in the US and work within ±2 hours of EST.');
    expect(r.remoteScope.value).toMatchObject({
      type: 'country',
      countries: ['US'],
      timezone: { minUtcOffset: -7, maxUtcOffset: -3 },
    });
  });
});

describe('worldwide and unclear', () => {
  it('requires an explicit worldwide statement', () => {
    expect(scope('Fully distributed, work from anywhere.').remoteScope.value.type).toBe('worldwide');
    expect(scope('Remote, anywhere in the world.').remoteScope.value.type).toBe('worldwide');
    expect(scope('Remote, worldwide.').remoteScope.confidence).toBe('high');
  });

  it('uses an Anywhere label with medium confidence', () => {
    const r = scope('Great team.', { locationTexts: ['Anywhere'] });
    expect(r.remoteScope).toMatchObject({
      value: { type: 'worldwide' },
      confidence: 'medium',
      basis: 'location.label',
    });
  });

  it('never invents worldwide for a plain Remote label', () => {
    const r = scope('We build developer tools.');
    expect(r.remoteScope).toEqual({
      value: {
        type: 'unclear',
        countries: [],
        regions: [],
        excludedCountries: [],
        excludedRegions: [],
        timezone: null,
      },
      confidence: 'unknown',
      evidence: [],
      basis: 'none',
    });
  });

  it('prefers a stated restriction over a "work from anywhere in X" worldwide reading', () => {
    expect(scope('Work from anywhere in the US.').remoteScope.value).toMatchObject({
      type: 'country',
      countries: ['US'],
    });
  });

  it('uses location/title labels when the body is silent', () => {
    expect(scope('', { locationTexts: ['Remote - Canada'] }).remoteScope.value).toMatchObject({
      type: 'country',
      countries: ['CA'],
    });
    expect(
      scope('', { locationTexts: ['Remote'], title: 'Engineer (Remote, UK)' }).remoteScope.value,
    ).toMatchObject({
      type: 'country',
      countries: ['GB'],
    });
  });

  it('is not applicable for hybrid/onsite and unclear for unclear work models', () => {
    expect(scope('Must be based in the US.', { workModel: 'hybrid' }).remoteScope.value.type).toBe(
      'not_applicable',
    );
    expect(scope('Must be based in the US.', { workModel: 'unclear' }).remoteScope).toMatchObject({
      value: { type: 'unclear' },
      confidence: 'unknown',
    });
  });
});

describe('findRemoteRestrictions', () => {
  it('uses authorization statements as weaker country evidence', () => {
    const [r] = findRemoteRestrictions('You must be authorized to work in Canada.');
    expect(r).toMatchObject({ kind: 'authorization', countries: ['CA'], strong: false });
    expect(scope('You must be authorized to work in Canada.').remoteScope.confidence).toBe('medium');
  });
});
