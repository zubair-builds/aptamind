import { describe, expect, it } from 'vitest';
import { categorize, extractRequirements, parseYears } from './requirements';
import { classifyHeading, detectSections } from './sections';

describe('classifyHeading', () => {
  it.each([
    ['Requirements', 'requirements'],
    ["What you'll need:", 'requirements'],
    ['What You’ll Need', 'requirements'],
    ['Qualifications', 'requirements'],
    ['**About you**', 'requirements'],
    ['Must have', 'must_have'],
    ['Minimum Qualifications', 'must_have'],
    ['Nice to have', 'preferred'],
    ['Nice-to-haves', 'preferred'],
    ['Bonus points', 'preferred'],
    ['Bonus points if you have:', 'preferred'],
    ['Preferred Qualifications', 'preferred'],
    ["What you'll do", 'responsibilities'],
    ['Responsibilities', 'responsibilities'],
    ['Tech stack', 'stack'],
    ['Benefits', 'other'],
    ['About Acme', 'other'],
  ])('%s → %s', (heading, kind) => {
    expect(classifyHeading(heading)).toBe(kind);
  });

  it('returns null for ordinary lines', () => {
    expect(classifyHeading('You will build the future of payments with us.')).toBeNull();
  });
});

describe('detectSections', () => {
  it('groups items under headings and handles inline headings', () => {
    const text =
      'Intro text.\n\nRequirements:\n- Go\n- Rust\n\nNice to have: Kafka experience.\n\nBENEFITS\n- Pension';
    const sections = detectSections(text);
    expect(sections.map((s) => [s.kind, s.heading, s.items.map((i) => i.text)])).toEqual([
      ['other', null, ['Intro text.']],
      ['requirements', 'Requirements', ['Go', 'Rust']],
      ['preferred', 'Nice to have', ['Kafka experience.']],
      ['other', 'BENEFITS', ['Pension']],
    ]);
    for (const s of sections) for (const i of s.items) expect(text.slice(i.start, i.end)).toBe(i.text);
  });
});

describe('parseYears', () => {
  it.each([
    ['5+ years of experience', 5],
    ['3-5 years', 3],
    ['at least five years', 5],
    ['minimum of 2 yrs', 2],
    ['Three (3) years of experience', 3],
    ['Experience with Go', null],
  ])('%s → %s', (text, years) => {
    expect(parseYears(text)).toBe(years);
  });
});

describe('categorize', () => {
  it.each([
    ['Right to work in the UK', 'authorization'],
    ['Must be based in London', 'location'],
    ['Fluent German (C1)', 'language'],
    ['BSc in Computer Science or related field', 'education'],
    ['AWS Certified Solutions Architect certification', 'certification'],
    ['Strong communication skills', 'soft_skill'],
    ['Experience with Kubernetes', 'skill'],
    ['Cloud-native mindset with Go', 'skill'],
    ['Experience in high-growth startups', 'experience'],
    ['A love of dogs', 'other'],
  ])('%s → %s', (text, category) => {
    const skill = /Kubernetes/.test(text) ? 'kubernetes' : /\bGo\b/.test(text) ? 'go' : null;
    expect(categorize(text, parseYears(text), skill)).toBe(category);
  });
});

describe('extractRequirements', () => {
  const text = `About us
We build tools.

Requirements
- 5+ years of experience with TypeScript
- Strong SQL skills
- You must have excellent written English
- Familiarity with Terraform
- Experience with GraphQL is a plus

Nice to have
- Rust

Benefits
- 25 days holiday

Experience with Docker is required.`;

  const reqs = extractRequirements(text);

  it('extracts one requirement per item with importance', () => {
    expect(reqs.map((r) => [r.text, r.importance, r.explicitness])).toEqual([
      ['5+ years of experience with TypeScript', 'important', 'inferred'],
      ['Strong SQL skills', 'important', 'inferred'],
      ['You must have excellent written English', 'critical', 'explicit'],
      ['Familiarity with Terraform', 'incidental', 'inferred'],
      ['Experience with GraphQL is a plus', 'preferred', 'explicit'],
      ['Rust', 'preferred', 'explicit'],
      ['Experience with Docker is required', 'critical', 'explicit'],
    ]);
  });

  it('normalises concepts, years, categories and sections', () => {
    expect(reqs[0]).toMatchObject({
      normalizedConcept: 'typescript',
      yearsMin: 5,
      category: 'experience',
      section: 'Requirements',
    });
    expect(reqs[1]).toMatchObject({ normalizedConcept: 'sql', category: 'skill' });
    expect(reqs[5]).toMatchObject({ normalizedConcept: 'rust', section: 'Nice to have' });
    expect(reqs[6]).toMatchObject({ section: null, confidence: 'medium' });
  });

  it('keeps verbatim evidence offsets', () => {
    for (const r of reqs) {
      expect(text.slice(r.evidence.start ?? 0, r.evidence.end)).toBe(r.evidence.quote);
      expect(r.evidence.quote).toBe(r.text);
    }
  });

  it('skips benefits and responsibilities', () => {
    expect(reqs.some((r) => /holiday/.test(r.text))).toBe(false);
    expect(extractRequirements("What you'll do\n- Build APIs in Go")).toEqual([]);
  });

  it('returns nothing for sparse text', () => {
    expect(extractRequirements('Join our team. Apply now.')).toEqual([]);
  });

  it('treats must-have sections as critical and stack sections as incidental', () => {
    const r = extractRequirements('Must have\n- Python\n\nOur stack\n- Kafka');
    expect(r.map((x) => [x.normalizedConcept, x.importance])).toEqual([
      ['python', 'critical'],
      ['kafka', 'incidental'],
    ]);
  });
});
