/**
 * Structured extraction golden set (P1.3 exit: 100 %). Each case is a stored form and the exact
 * statements the deterministic extractor must produce — claim type, locator, normalized payload
 * and verbatim quote. Any difference fails the case; the set passes only at 100 %.
 */
import { describe, expect, it } from 'vitest';
import { extractStatements, type StructuredStatement } from './extractor';

interface GoldenCase {
  id: string;
  form: unknown;
  expected: StructuredStatement[];
}

const asOf = '2026-09-01T00:00:00.000Z';
const LONG = 'L'.repeat(190);

const CASES: GoldenCase[] = [
  {
    id: 'questionnaire-full',
    form: {
      form: 'questionnaire',
      version: 1,
      answers: {
        headline: 'Senior product designer',
        current_location: { city: 'Dubai', country: 'AE' },
        remote: { acceptable: ['remote', 'hybrid'], preferred: 'remote' },
        relocation: { willing: 'conditional', destinations: ['GB', 'NL'] },
        work_authorization: [{ jurisdiction: 'AE', status: 'visa', sponsorshipRequired: 'no' }],
        languages: [
          { label: 'English', proficiency: 'fluent' },
          { label: 'Klingon', proficiency: 'basic' },
        ],
        skills: [{ label: 'Figma', kind: 'tool', proficiency: 'expert' }, { label: 'Service blueprints' }],
        links: [{ kind: 'portfolio', url: 'https://persona.example/work' }],
      },
    },
    expected: [
      {
        claimType: 'positioning.headline',
        payload: { text: 'Senior product designer' },
        locator: '/answers/headline',
        quote: 'Senior product designer',
      },
      {
        claimType: 'location.current',
        payload: { city: 'Dubai', country: 'AE' },
        locator: '/answers/current_location',
        quote: '{"city":"Dubai","country":"AE"}',
      },
      {
        claimType: 'preference.remote',
        payload: { acceptable: ['remote', 'hybrid'], preferred: 'remote' },
        locator: '/answers/remote',
        quote: '{"acceptable":["remote","hybrid"],"preferred":"remote"}',
      },
      {
        claimType: 'mobility.relocation',
        payload: { willing: 'conditional', destinations: ['GB', 'NL'] },
        locator: '/answers/relocation',
        quote: '{"destinations":["GB","NL"],"willing":"conditional"}',
      },
      {
        claimType: 'work_authorization',
        payload: { jurisdiction: 'AE', status: 'visa', sponsorshipRequired: 'no' },
        locator: '/answers/work_authorization/0',
        quote: '{"jurisdiction":"AE","sponsorshipRequired":"no","status":"visa"}',
      },
      {
        claimType: 'language',
        payload: { label: 'English', language: 'english', proficiency: 'fluent' },
        locator: '/answers/languages/0',
        quote: '{"label":"English","proficiency":"fluent"}',
      },
      {
        claimType: 'language',
        payload: { label: 'Klingon', language: null, proficiency: 'basic' },
        locator: '/answers/languages/1',
        quote: '{"label":"Klingon","proficiency":"basic"}',
      },
      {
        claimType: 'skill',
        payload: {
          label: 'Figma',
          concept: 'figma',
          category: 'design',
          kind: 'tool',
          proficiency: 'expert',
          context: 'listed',
        },
        locator: '/answers/skills/0',
        quote: '{"kind":"tool","label":"Figma","proficiency":"expert"}',
      },
      {
        claimType: 'skill',
        payload: { label: 'Service blueprints', concept: null, kind: 'skill', context: 'listed' },
        locator: '/answers/skills/1',
        quote: '{"label":"Service blueprints"}',
      },
      {
        claimType: 'identity.link',
        payload: { kind: 'portfolio', url: 'https://persona.example/work' },
        locator: '/answers/links/0',
        quote: '{"kind":"portfolio","url":"https://persona.example/work"}',
      },
    ],
  },
  {
    id: 'manual-role-and-education',
    form: {
      form: 'manual_input',
      version: 1,
      statements: [
        {
          claimType: 'experience.role',
          value: {
            organization: { name: 'Acme Ltd' },
            title: 'Lead Designer',
            start: { year: 2021, month: 3 },
            end: { open: true, asOf },
          },
        },
        {
          claimType: 'education',
          value: {
            institution: { name: 'Example University' },
            qualification: 'BA Design',
            level: 'bachelor',
            end: { year: 2015 },
            status: 'completed',
          },
        },
      ],
    },
    expected: [
      {
        claimType: 'experience.role',
        payload: {
          organization: { name: 'Acme Ltd', key: 'acme_ltd' },
          title: 'Lead Designer',
          titleKey: 'lead_designer',
          start: { year: 2021, month: 3 },
          end: { open: true, asOf: new Date(asOf) },
        },
        locator: '/statements/0/value',
        quote:
          '{"end":{"asOf":"2026-09-01T00:00:00.000Z","open":true},"organization":{"name":"Acme Ltd"},"start":{"month":3,"year":2021},"title":"Lead Designer"}',
      },
      {
        claimType: 'education',
        payload: {
          institution: { name: 'Example University', key: 'example_university' },
          qualification: 'BA Design',
          level: 'bachelor',
          end: { year: 2015 },
          status: 'completed',
        },
        locator: '/statements/1/value',
        quote:
          '{"end":{"year":2015},"institution":{"name":"Example University"},"level":"bachelor","qualification":"BA Design","status":"completed"}',
      },
    ],
  },
  {
    id: 'manual-trims-and-normalizes',
    form: {
      form: 'manual_input',
      version: 1,
      statements: [{ claimType: 'identity.name', value: { display: '  Persona Alpha  ' } }],
    },
    expected: [
      {
        claimType: 'identity.name',
        payload: { display: 'Persona Alpha' },
        locator: '/statements/0/value',
        quote: '{"display":"  Persona Alpha  "}',
      },
    ],
  },
  {
    id: 'manual-other-claim-types',
    form: {
      form: 'manual_input',
      version: 1,
      statements: [
        { claimType: 'identity.link', value: { kind: 'github', url: 'https://github.com/persona-alpha' } },
        {
          claimType: 'certification',
          value: { name: 'AWS "Solutions" Architect', issuer: 'Amazon', issued: { year: 2023, month: 5 } },
        },
        {
          claimType: 'work_authorization',
          value: {
            jurisdiction: 'GB',
            status: 'visa',
            visaType: 'Skilled Worker',
            validUntil: { year: 2027 },
            sponsorshipRequired: 'yes',
          },
        },
        { claimType: 'mobility.relocation', value: { willing: 'yes', destinations: ['NL'] } },
        { claimType: 'preference.remote', value: { acceptable: ['remote'] } },
        { claimType: 'location.current', value: { city: 'Leeds', country: 'GB' } },
        { claimType: 'language', value: { label: 'German', proficiency: 'cefr:B2' } },
        { claimType: 'skill', value: { label: 'TypeScript', kind: 'skill', proficiency: 'advanced' } },
      ],
    },
    expected: [
      {
        claimType: 'identity.link',
        payload: { kind: 'github', url: 'https://github.com/persona-alpha' },
        locator: '/statements/0/value',
        quote: '{"kind":"github","url":"https://github.com/persona-alpha"}',
      },
      {
        claimType: 'certification',
        payload: { name: 'AWS "Solutions" Architect', issuer: 'Amazon', issued: { year: 2023, month: 5 } },
        locator: '/statements/1/value',
        quote: '{"issued":{"month":5,"year":2023},"issuer":"Amazon","name":"AWS \\"Solutions\\" Architect"}',
      },
      {
        claimType: 'work_authorization',
        payload: {
          jurisdiction: 'GB',
          status: 'visa',
          visaType: 'Skilled Worker',
          validUntil: { year: 2027 },
          sponsorshipRequired: 'yes',
        },
        locator: '/statements/2/value',
        quote:
          '{"jurisdiction":"GB","sponsorshipRequired":"yes","status":"visa","validUntil":{"year":2027},"visaType":"Skilled Worker"}',
      },
      {
        claimType: 'mobility.relocation',
        payload: { willing: 'yes', destinations: ['NL'] },
        locator: '/statements/3/value',
        quote: '{"destinations":["NL"],"willing":"yes"}',
      },
      {
        claimType: 'preference.remote',
        payload: { acceptable: ['remote'] },
        locator: '/statements/4/value',
        quote: '{"acceptable":["remote"]}',
      },
      {
        claimType: 'location.current',
        payload: { city: 'Leeds', country: 'GB' },
        locator: '/statements/5/value',
        quote: '{"city":"Leeds","country":"GB"}',
      },
      {
        claimType: 'language',
        payload: { label: 'German', language: 'german', proficiency: 'cefr:B2' },
        locator: '/statements/6/value',
        quote: '{"label":"German","proficiency":"cefr:B2"}',
      },
      {
        claimType: 'skill',
        payload: {
          label: 'TypeScript',
          concept: 'typescript',
          category: 'language',
          kind: 'skill',
          proficiency: 'advanced',
          context: 'listed',
        },
        locator: '/statements/7/value',
        quote: '{"kind":"skill","label":"TypeScript","proficiency":"advanced"}',
      },
    ],
  },
  {
    id: 'manual-duplicates-are-distinct-statements',
    form: {
      form: 'manual_input',
      version: 1,
      statements: [
        { claimType: 'skill', value: { label: 'Figma', kind: 'tool' } },
        { claimType: 'skill', value: { label: 'Figma', kind: 'tool' } },
      ],
    },
    expected: [0, 1].map((i) => ({
      claimType: 'skill' as const,
      payload: { label: 'Figma', concept: 'figma', category: 'design', kind: 'tool', context: 'listed' },
      locator: `/statements/${i}/value`,
      quote: '{"kind":"tool","label":"Figma"}',
    })),
  },
  {
    id: 'questionnaire-escaping-verbatim',
    form: { form: 'questionnaire', version: 1, answers: { headline: 'He said "hi"\n— ünïcode ✓' } },
    expected: [
      {
        claimType: 'positioning.headline',
        payload: { text: 'He said "hi"\n— ünïcode ✓' },
        locator: '/answers/headline',
        quote: 'He said "hi"\n— ünïcode ✓',
      },
    ],
  },
  {
    id: 'manual-field-over-300-chars-has-no-quote',
    form: {
      form: 'manual_input',
      version: 1,
      statements: [
        {
          claimType: 'experience.role',
          value: { organization: { name: LONG }, title: LONG, start: { year: 2020 }, end: { year: 2021 } },
        },
      ],
    },
    expected: [
      {
        claimType: 'experience.role',
        payload: {
          organization: { name: LONG, key: LONG.toLowerCase() },
          title: LONG,
          titleKey: LONG.toLowerCase(),
          start: { year: 2020 },
          end: { year: 2021 },
        },
        locator: '/statements/0/value',
      },
    ],
  },
];

describe('structured extraction golden set', () => {
  it.each(CASES)('$id', ({ form, expected }) => {
    expect(extractStatements(form)).toEqual(expected);
  });

  it('passes at 100 %', () => {
    const passed = CASES.filter((c) => {
      try {
        expect(extractStatements(c.form)).toEqual(c.expected);
        return true;
      } catch {
        return false;
      }
    });
    expect(passed.length / CASES.length).toBe(1);
  });
});
