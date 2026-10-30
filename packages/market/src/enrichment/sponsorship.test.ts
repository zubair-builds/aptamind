import { describe, expect, it } from 'vitest';
import { interpretationFlagSchema } from '../contracts/employment';
import { jobsCollection } from '../jobs/job.schema';
import { htmlToTextWithLayout } from './html';
import { findSponsorshipStatements, interpretSponsorship } from './sponsorship';
import type { SponsorshipInput } from './sponsorship';

const licensedGB = { sponsorLicenceCountries: ['GB'], historicalSponsorshipCountries: [] };

function run(
  description: string,
  company: SponsorshipInput['company'] = null,
  jobCountries: string[] = ['GB'],
) {
  return interpretSponsorship({ description, company, jobCountries });
}

describe('posting statements (DECISION_LOG 012d041: posting text never yields a verdict)', () => {
  const stances = (text: string, jobCountries: string[] = ['GB']) =>
    findSponsorshipStatements(text, { jobCountries }).map((s) => s.stance);
  const stated = (text: string, jobCountries: string[] = ['GB']) =>
    interpretSponsorship({ description: text, company: null, jobCountries }).flags.filter(
      (f) => f.code === 'sponsorship_stated',
    );

  it.each([
    ['Visa sponsorship: yes', 'yes'],
    ['Visa sponsorship: No.', 'no'],
    ['• Work permit sponsorship - No', 'no'],
    ['Tier 2 sponsorship: yes', 'yes'],
    ['- Skilled Worker visa sponsorship – Yes', 'yes'],
    ['**Visa sponsorship:** Yes', 'yes'], // 3dfe3c5: paired bold around the whole key
    ['**Visa sponsorship**: No', 'no'],
    ['Visa sponsorship: **No**', 'no'], // … or the whole value
    ['Immigration sponsorship: no.', 'no'],
    ['Visa sponsorship：Yes', 'yes'], // NFKC: a full-width colon is a colon
    ['Visa Sponsorship Available: No', 'no'], // M1 key forms
    ['Visa sponsorship offered: Yes', 'yes'],
    ['Visa sponsorship provided: No', 'no'],
    ['Work permit sponsorship = no', 'no'], // 8d96663: `=` separator
    ['Visa\u200B spon\u200Dsorship\uFEFF: No', 'no'], // L2: zero-width characters stripped
  ])('a structured line "%s" states %s: unclear + sponsorship_stated, never a verdict', (text, value) => {
    const r = run(text);
    expect(r.sponsorship.value).toMatchObject({ status: 'unclear', roleStatement: 'none' });
    expect(r.sponsorship.basis).toBe('description.stated');
    expect(stated(text)).toEqual([
      expect.objectContaining({ value, evidence: expect.objectContaining({ field: 'description' }) }),
    ]);
  });

  it.each([
    'Sponsorship: Yes',
    'Visa sponsorship: Yes*',
    'Visa sponsorship: Yes (London office)',
    'Visa sponsorship: N/A',
    'Great benefits. Visa sponsorship: yes',
    'We can sponsor your visa.',
    'We sponsor no visas.',
    'You must have the right to work in the UK.',
  ])('"%s" is a mention, with no stated value', (text) => {
    expect(stances(text)).toEqual(['mention']);
    expect(stated(text)).toEqual([]);
    const r = run(text);
    expect(r.sponsorship.value.status).toBe('unclear');
    expect(r.flags.map((f) => f.code)).toEqual(['sponsorship_mentioned']);
  });

  it.each([
    // PR #21 re-verify #8 H1: key and value on different lines, or no separator (DECISION_LOG 8d96663).
    'Visa sponsorship available\nNo',
    'Visa sponsorship offered\nNo',
    'Visa sponsorship provided\n\nNo',
    '<dl><dt>Visa sponsorship available</dt><dd>No</dd></dl>',
    '<div class="label">Visa sponsorship available</div><div class="value">No</div>',
    '<h3>Visa sponsorship available</h3><p>No, applicants must hold settled status.</p>',
    'Visa sponsorship provided\n☐ Yes ☒ No',
    'Visa sponsorship available\nNot for this role',
    'Tier 2 sponsorship available',
    'Immigration sponsorship unavailable.',
    '- Visa sponsorship available\n- No relocation budget',
    // 3dfe3c5 (1): table layouts, (2) values other than yes/no and footnote markers.
    '| Visa sponsorship | Yes |',
    '<table><tr><th>Visa sponsorship</th><td>No</td></tr></table>',
    '<table><tr><td>Visa sponsorship:</td><td>No</td></tr></table>',
    '<table><tr><th>Benefit</th><th>Full-time</th><th>Contractor</th></tr><tr><td>Visa sponsorship:</td><td></td><td>No</td></tr></table>',
    '<table><tr><td>Visa sponsorship</td><td>No<br>Exceptions considered for principal engineers</td></tr></table>',
    'Visa sponsorship: Not available',
    'Tier 2 sponsorship: available',
    'Visa sponsorship: No**',
    'Visa sponsorship: No*',
    'Visa sponsorship: Yes†',
    'Visa sponsorship: No¹',
    'Visa sponsorship: No^1',
    '<ul><li>Visa sponsorship: No<sup>**</sup></li></ul>',
    '**Visa sponsorship: No**',
  ])('a key line without a same-line separator is a mention, never a stated value: %j', (raw) => {
    const { text, layoutLineStarts } = /<[a-z]/.test(raw)
      ? htmlToTextWithLayout(raw)
      : { text: raw, layoutLineStarts: [] };
    const stances = (t: string) =>
      findSponsorshipStatements(t, { jobCountries: ['GB'], layoutLineStarts }).map((x) => x.stance);
    const stated = (t: string) =>
      interpretSponsorship({
        description: t,
        layoutLineStarts,
        company: null,
        jobCountries: ['GB'],
      }).flags.filter((f) => f.code === 'sponsorship_stated');
    expect(stated(text)).toEqual([]);
    expect(stances(text)).toContain('mention');
    expect(stances(text)).not.toContain('yes');
    expect(stances(text)).not.toContain('no');
    expect(run(text).sponsorship.value.status).toBe('unclear');
  });

  it('a stated value keeps its key scope: H-1B "no" in a London + New York job does not override a GB licence (bc013e8 M4)', () => {
    const r = run('H-1B sponsorship: No\nUK roles: Skilled Worker sponsorship considered.', licensedGB, [
      'GB',
      'US',
    ]);
    const stated = r.flags.find((f) => f.code === 'sponsorship_stated');
    expect(stated).toMatchObject({ value: 'no', scope: ['US'] });
    expect(stated!.message).toContain('"H-1B sponsorship: no"');
    expect(stated!.message).not.toContain('visa sponsorship: no');
    expect(r.flags.map((f) => f.code)).not.toContain('sponsorship_role_overrides_company');
    expect(r.sponsorship).toMatchObject({ value: { status: 'company_capable' }, confidence: 'medium' });
    // A Skilled Worker (GB) "no" does overlap the GB licence.
    const gb = run('Skilled Worker sponsorship: No', licensedGB, ['GB', 'US']);
    expect(gb.flags.map((f) => f.code)).toContain('sponsorship_role_overrides_company');
    expect(gb.sponsorship.confidence).toBe('low');
    // A generic key has no scope and counts where the licence covers the job.
    const generic = run('Visa sponsorship: No', licensedGB, ['GB', 'US']);
    expect(generic.flags.find((f) => f.code === 'sponsorship_stated')?.scope).toBeUndefined();
    expect(generic.flags.map((f) => f.code)).toContain('sponsorship_role_overrides_company');
  });

  it('polarities conflict only where key scopes overlap (bc013e8 L3)', () => {
    const r = run('Skilled Worker sponsorship: Yes\nH-1B sponsorship: No', null, ['GB', 'US']);
    expect(r.flags.filter((f) => f.code === 'sponsorship_stated').map((f) => f.value)).toEqual(['yes', 'no']);
    expect(r.flags.map((f) => f.code)).not.toContain('sponsorship_conflict');
    expect(r.sponsorship.basis).not.toBe('description.conflict');
    // A generic key overlaps every scope.
    expect(
      run('Visa sponsorship: Yes\nH-1B sponsorship: No', null, ['GB', 'US']).flags.map((f) => f.code),
    ).toContain('sponsorship_conflict');
    expect(
      run('Skilled Worker sponsorship: Yes\nTier 2 sponsorship: No', null, ['GB']).flags.map((f) => f.code),
    ).toContain('sponsorship_conflict');
  });

  it('the licence test uses scope ∩ licence ∩ job countries (bc013e8 L4)', () => {
    const gbNl = { sponsorLicenceCountries: ['GB', 'NL'], historicalSponsorshipCountries: [] };
    const r = run('EU Blue Card sponsorship: No', gbNl, ['DE', 'GB']);
    expect(r.flags.find((f) => f.code === 'sponsorship_stated')).toMatchObject({ value: 'no' });
    expect(r.flags.map((f) => f.code)).not.toContain('sponsorship_role_overrides_company');
    expect(r.sponsorship).toMatchObject({ value: { status: 'company_capable' }, confidence: 'medium' });
    // An Amsterdam job: the Blue Card scope, the NL licence and the job meet.
    expect(run('EU Blue Card sponsorship: No', gbNl, ['NL']).flags.map((f) => f.code)).toContain(
      'sponsorship_role_overrides_company',
    );
  });

  it('the numero sign is not "no" (7f01fe5 L3)', () => {
    expect(stances('Visa sponsorship: №')).toEqual(['mention']);
    expect(stated('Visa sponsorship: №')).toEqual([]);
    expect(stated('Visa sponsorship: No')).toMatchObject([{ value: 'no' }]);
  });

  it('a footnote line after a stated line is itself a mention (restriction cues tested before stripping)', () => {
    const r = findSponsorshipStatements('- Visa sponsorship: No**\n** Except for staff engineering roles.', {
      jobCountries: ['GB'],
    });
    expect(r.map((x) => [x.stance, x.sentence.text])).toEqual([
      ['mention', 'Visa sponsorship: No**'],
      ['mention', '** Except for staff engineering roles.'],
    ]);
  });

  it.each([
    'Visumsponsoring möglich',
    'Visaunterstützung vorhanden',
    'Arbeitsvisa werden gestellt',
    'Visumsponsoring: Ja',
    'Visa\u200Bsponsorship available',
  ])('compounds are related content (relevance only, never a stated value): %j', (text) => {
    expect(stances(text)).toEqual(['mention']);
    expect(stated(text)).toEqual([]);
  });

  it('a visa type for another country than the job’s (or unknown countries) states nothing; Blue Card excludes IE and DK', () => {
    expect(stated('H-1B sponsorship: yes')).toEqual([]);
    expect(stated('H-1B sponsorship: yes', ['US'])).toMatchObject([{ value: 'yes' }]);
    expect(stated('Skilled Worker sponsorship: yes', [])).toEqual([]);
    expect(stated('Visa sponsorship: yes', [])).toMatchObject([{ value: 'yes' }]);
    expect(stated('EU Blue Card sponsorship: yes', ['IE'])).toEqual([]);
    expect(stated('EU Blue Card sponsorship: yes', ['DK'])).toEqual([]);
    expect(stated('EU Blue Card sponsorship: yes', ['DE'])).toMatchObject([{ value: 'yes' }]);
  });

  it('a stated value with any other related content adds sponsorship_mixed_statement', () => {
    const r = run('Visa sponsorship: Yes\nWe don’t sponsor visas.');
    expect(r.flags.map((f) => f.code).sort()).toEqual([
      'sponsorship_mentioned',
      'sponsorship_mixed_statement',
      'sponsorship_stated',
    ]);
    expect(r.sponsorship.value.status).toBe('unclear');
  });

  it('contradictory stated values are a conflict (high flag → employment_conflict review)', () => {
    const r = run('Visa sponsorship: yes\nVisa sponsorship: no');
    expect(r.sponsorship).toMatchObject({ value: { status: 'unclear' }, basis: 'description.conflict' });
    expect(r.flags.filter((f) => f.code === 'sponsorship_stated').map((f) => f.value)).toEqual(['yes', 'no']);
    expect(r.flags).toContainEqual(
      expect.objectContaining({ code: 'sponsorship_conflict', severity: 'high' }),
    );
  });

  it('title and location are scanned for mentions (never for stated values)', () => {
    const r = interpretSponsorship({
      description: 'You will build our payments platform.',
      title: 'Backend Engineer (No Visa Sponsorship)',
      locationTexts: ['New York, NY (US Citizens Only)'],
      company: null,
      jobCountries: ['US'],
    });
    expect(r.flags.map((f) => f.code)).toEqual(['sponsorship_mentioned']);
    expect(r.sponsorship.evidence.map((e) => e.field)).toEqual(['title', 'location']);
    expect(
      interpretSponsorship({
        description: '',
        title: 'Visa sponsorship: Yes',
        company: null,
        jobCountries: ['GB'],
      }).flags.map((f) => f.code),
    ).toEqual(['sponsorship_mentioned']);
  });

  it('ignores text without related content', () => {
    expect(findSponsorshipStatements('Great benefits and a friendly team.')).toEqual([]);
  });
});

describe('interpretSponsorship', () => {
  it('a stated no with a licence covering the job: status follows the company axis, flagged role_overrides_company (8d96663 L1)', () => {
    const r = run('Visa sponsorship: No', licensedGB);
    expect(r.sponsorship.value).toEqual({
      status: 'company_capable',
      roleStatement: 'none',
      companyCapability: 'licensed',
      capabilityCountries: ['GB'],
    });
    // The stated "no" is in tension with the capability: low confidence, both kinds of evidence.
    expect(r.sponsorship.confidence).toBe('low');
    expect(r.sponsorship.basis).toBe('company.sponsorLicence');
    expect(r.sponsorship.evidence.map((e) => e.field)).toEqual(['company', 'description']);
    expect(r.flags.map((f) => f.code)).toEqual(['sponsorship_stated', 'sponsorship_role_overrides_company']);
    // Company-level flags are emitted as before when a value is stated.
    expect(run('Visa sponsorship: No', licensedGB, ['US']).flags.map((f) => f.code)).toEqual([
      'sponsorship_stated',
      'sponsor_capability_other_country',
    ]);
    expect(run('Visa sponsorship: Yes', licensedGB, []).flags.map((f) => f.code)).toEqual([
      'sponsorship_stated',
      'sponsor_capability_job_country_unknown',
    ]);
    const lapsed = run('Visa sponsorship: Yes', {
      sponsorLicenceCountries: [],
      historicalSponsorshipCountries: [],
      previousLicenceCountries: ['GB'],
    });
    expect(lapsed.sponsorship.value).toMatchObject({
      status: 'unclear',
      companyCapability: 'previously_licensed',
    });
    expect(lapsed.sponsorship.basis).toBe('company.previousLicence');
    expect(lapsed.flags.map((f) => f.code)).toEqual(['sponsorship_stated', 'sponsor_licence_lapsed']);
    // A stated yes with a licence covering the job keeps the capability at medium confidence.
    expect(run('Visa sponsorship: Yes', licensedGB).sponsorship).toMatchObject({
      value: { status: 'company_capable' },
      confidence: 'medium',
    });
  });

  it('company licence with a silent role is company_capable, never explicit_yes', () => {
    const r = run('We build great products.', licensedGB);
    expect(r.sponsorship.value).toMatchObject({
      status: 'company_capable',
      roleStatement: 'none',
      companyCapability: 'licensed',
    });
    expect(r.sponsorship.confidence).toBe('medium');
    expect(r.sponsorship.evidence).toEqual([{ field: 'company', quote: 'sponsorLicenceCountries: GB' }]);
  });

  it('company licence in another country than the job stays unclear', () => {
    const r = run('We build great products.', licensedGB, ['US']);
    expect(r.sponsorship.value.status).toBe('unclear');
    expect(r.sponsorship.value.companyCapability).toBe('licensed');
    expect(r.flags.map((f) => f.code)).toEqual(['sponsor_capability_other_country']);
  });

  it('historical-only evidence', () => {
    const r = run('', { sponsorLicenceCountries: [], historicalSponsorshipCountries: ['GB'] });
    expect(r.sponsorship.value).toMatchObject({
      status: 'historical_evidence',
      companyCapability: 'historical',
    });
    expect(r.sponsorship.confidence).toBe('low');
  });

  it('a free-text mention is kept as evidence and does not change company capability', () => {
    const r = run('Build our data platform.\n\nWe cannot offer visa sponsorship.', licensedGB);
    expect(r.sponsorship.value.status).toBe('company_capable');
    expect(r.sponsorship.confidence).toBe('medium');
    expect(r.sponsorship.evidence.map((e) => e.quote)).toContain('We cannot offer visa sponsorship.');
    expect(r.flags.map((f) => f.code)).toEqual(['sponsorship_mentioned']);
    const silent = run('Visa sponsorship may be available for exceptional candidates.');
    expect(silent.sponsorship).toMatchObject({ value: { status: 'unclear' }, basis: 'description.mention' });
  });

  it('unknown stays unknown without company data', () => {
    const r = run('We build great products.', null);
    expect(r.sponsorship).toEqual({
      value: {
        status: 'unclear',
        roleStatement: 'none',
        companyCapability: 'unknown',
        capabilityCountries: [],
      },
      confidence: 'unknown',
      evidence: [],
      basis: 'none',
    });
    expect(
      run('', { sponsorLicenceCountries: [], historicalSponsorshipCountries: [] }).sponsorship.value
        .companyCapability,
    ).toBe('none');
  });

  describe('M11.1 evidence hierarchy', () => {
    const rtw = (countries: string[], required: boolean | null = true, regions: string[] = []) => ({
      required,
      countries,
      regions,
    });

    it('A-L3: a region-level requirement covers its member countries and the flag names the region', () => {
      const r = interpretSponsorship({
        description: '',
        company: { sponsorLicenceCountries: ['DE'], historicalSponsorshipCountries: [] },
        jobCountries: ['DE'],
        rightToWork: rtw([], true, ['EU']),
      });
      const flag = r.flags.find((f) => f.code === 'right_to_work_required_with_sponsor_capability');
      expect(flag?.message).toContain('(EU)');
      expect(flag?.message).not.toContain('AT');
    });

    it('a licence with unknown job countries is unclear; the capability is recorded', () => {
      const r = run('We build great products.', licensedGB, []);
      expect(r.sponsorship).toMatchObject({
        value: {
          status: 'unclear',
          roleStatement: 'none',
          companyCapability: 'licensed',
          capabilityCountries: ['GB'],
        },
        confidence: 'unknown',
        basis: 'company.sponsorLicence.job_country_unknown',
        evidence: [{ field: 'company', quote: 'sponsorLicenceCountries: GB' }],
      });
      expect(r.flags.map((f) => f.code)).toEqual(['sponsor_capability_job_country_unknown']);
    });

    it('a stated value stays a statement when the job countries are unknown', () => {
      // A stated value is never a verdict, with or without known job countries (012d041).
      expect(run('Visa sponsorship: No', licensedGB, []).sponsorship.value.status).toBe('unclear');
      expect(run('Visa sponsorship available', licensedGB, []).sponsorship.value.status).toBe('unclear');
    });

    it('a right-to-work requirement where the licence applies lowers company_capable to low, flagged', () => {
      const r = interpretSponsorship({
        description: '',
        company: licensedGB,
        jobCountries: ['GB'],
        rightToWork: rtw(['GB']),
      });
      expect(r.sponsorship.value.status).toBe('company_capable');
      expect(r.sponsorship.confidence).toBe('low');
      expect(r.flags.map((f) => f.code)).toEqual(['right_to_work_required_with_sponsor_capability']);
    });

    it('a right-to-work requirement for another country, or none, leaves the capability as is', () => {
      for (const rightToWork of [rtw(['US']), rtw([], null)]) {
        const r = interpretSponsorship({
          description: '',
          company: licensedGB,
          jobCountries: ['GB'],
          rightToWork,
        });
        expect(r.sponsorship.confidence).toBe('medium');
        expect(r.flags).toEqual([]);
      }
    });

    it('a right-to-work requirement without a country is taken to apply to the job', () => {
      const r = interpretSponsorship({
        description: '',
        company: licensedGB,
        jobCountries: ['GB'],
        rightToWork: rtw([]),
      });
      expect(r.sponsorship.confidence).toBe('low');
    });

    it('a lapsed licence is past capability (previously_licensed), never history or a role signal', () => {
      const r = run('We build great products.', {
        sponsorLicenceCountries: [],
        historicalSponsorshipCountries: [],
        previousLicenceCountries: ['GB'],
      });
      expect(r.sponsorship.value).toEqual({
        status: 'unclear',
        roleStatement: 'none',
        companyCapability: 'previously_licensed',
        capabilityCountries: ['GB'],
      });
      expect(r.sponsorship.confidence).toBe('unknown');
      expect(r.flags.map((f) => f.code)).toEqual(['sponsor_licence_lapsed']);
    });

    it('the lapsed-licence flag says when the licence was for another country than the job', () => {
      const r = run(
        '',
        { sponsorLicenceCountries: [], historicalSponsorshipCountries: [], previousLicenceCountries: ['GB'] },
        ['DE'],
      );
      expect(r.flags.find((f) => f.code === 'sponsor_licence_lapsed')?.message).toMatch(
        /another country than the job's \(DE\)/,
      );
    });

    it('a current licence outranks a lapsed one in the same country', () => {
      const r = run('', {
        sponsorLicenceCountries: ['GB'],
        historicalSponsorshipCountries: [],
        previousLicenceCountries: ['GB'],
      });
      expect(r.sponsorship.value).toMatchObject({ status: 'company_capable', companyCapability: 'licensed' });
    });

    it.each([
      'We offer visa assistance and relocation support for successful candidates.',
      'Visa assistance is available for this role.',
      'Immigration support is provided.',
      'We will help you with your visa application.',
      'We do not offer visa assistance.',
      'Visa support: available',
    ])('bc50be7: assistance is not sponsorship, never a polarity: "%s"', (text) => {
      expect(run(text).sponsorship.value).toMatchObject({ status: 'unclear', roleStatement: 'none' });
    });

    it.each([
      [
        'a law firm offering immigration support to businesses',
        'We offer immigration support to businesses and individuals.',
      ],
      ['a duty', 'You will provide immigration support to employees relocating to the UK.'],
      ['a skill', 'Experience with visa assistance processes is a plus.'],
      ['a skill (older sponsorship pattern)', 'Experience with visa sponsorship processes is a plus.'],
      [
        'an exclusion frame (older visa-support pattern)',
        'Candidates with visa support needs will not be considered.',
      ],
      [
        'negation far before the phrase',
        'We regret that we are not in a position at this time to offer visa assistance.',
      ],
    ])('PR #21: %s is never explicit_yes', (_label, text) => {
      expect(run(text).sponsorship.value.status).not.toBe('explicit_yes');
    });
  });

  describe('precision-first (DECISION_LOG 9186ad2)', () => {
    it.each([
      'We provide visa sponsorship services to startups.',
      'Coordinate visa assistance provided to new hires.',
      'Our platform helps companies offer visa sponsorship to international talent.',
    ])('a service, duty or customer sentence is no statement: "%s"', (text) => {
      expect(run(text).sponsorship.value.status).toBe('unclear');
    });
  });
});

describe('flag value (8d96663 L3)', () => {
  const base = { code: 'sponsorship_stated', message: 'm', severity: 'info' as const };
  it('is narrowed to yes / no, optional (flags stored before v2.1 carry none and still parse)', () => {
    expect(interpretationFlagSchema.parse(base)).toEqual(base);
    expect(interpretationFlagSchema.parse({ ...base, value: 'no' }).value).toBe('no');
    expect(() => interpretationFlagSchema.parse({ ...base, value: 'maybe' })).toThrow();
  });
  it('every flag the interpreter emits fits the stored schema', () => {
    const r = run('Visa sponsorship: yes\nVisa sponsorship: no\nWe sponsor visas.', licensedGB);
    for (const f of r.flags) expect(interpretationFlagSchema.safeParse(f).success).toBe(true);
  });
  it('the $jsonSchema restricts the stored value to yes / no', () => {
    const flag = (
      jobsCollection.validator as {
        $jsonSchema: {
          properties: { interpretation: { properties: { flags: { items: Record<string, unknown> } } } };
        };
      }
    ).$jsonSchema.properties.interpretation.properties.flags.items;
    expect((flag.properties as Record<string, unknown>).value).toEqual({ enum: ['yes', 'no'] });
    expect(flag.required).not.toContain('value');
  });
});

describe('company axis per job country (M11.5)', () => {
  const company = {
    sponsorLicenceCountries: ['GB'],
    historicalSponsorshipCountries: ['US'],
    previousLicenceCountries: ['NL'],
  };
  const axis = (jobCountries: string[]) => {
    const v = run('Build our platform.', company, jobCountries).sponsorship.value;
    return [v.status, v.companyCapability, v.capabilityCountries];
  };

  it('takes the strongest tier covering the job: licence, then hiring history, then a lapsed licence', () => {
    expect(axis(['GB'])).toEqual(['company_capable', 'licensed', ['GB']]);
    expect(axis(['US'])).toEqual(['historical_evidence', 'historical', ['US']]);
    expect(axis(['NL'])).toEqual(['unclear', 'previously_licensed', ['NL']]);
    // Covered by none (or unknown countries): current capability is recorded, the status unclear.
    expect(axis(['DE'])).toEqual(['unclear', 'licensed', ['GB']]);
    expect(axis([])).toEqual(['unclear', 'licensed', ['GB']]);
  });

  it('keeps a lapsed licence for the job country when the company is licensed elsewhere (PR #21 L6)', () => {
    const v = run(
      'Build our platform.',
      {
        sponsorLicenceCountries: ['IE'],
        historicalSponsorshipCountries: [],
        previousLicenceCountries: ['GB'],
      },
      ['GB'],
    );
    expect(v.sponsorship.value).toMatchObject({
      status: 'unclear',
      companyCapability: 'previously_licensed',
      capabilityCountries: ['GB'],
    });
    expect(v.flags.map((f) => f.code)).toContain('sponsor_licence_lapsed');
  });

  it('hiring history never yields company_capable or a role statement', () => {
    const v = run(
      'Build our platform.',
      { sponsorLicenceCountries: [], historicalSponsorshipCountries: ['US'] },
      ['US'],
    ).sponsorship;
    expect(v.value).toMatchObject({ status: 'historical_evidence', roleStatement: 'none' });
    expect(v.confidence).toBe('low');
  });
});
