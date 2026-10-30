import { describe, expect, it } from 'vitest';
import { mapDirectoryRow, parseDirectoryConfig } from './company-directory';
import { bracketsPair, tokenizeAddress } from './contact-grammar';
import { contactValueVerdict, hasContactValue, reduceUrlCell } from './directory-values';

/** PR #27 re-verification #13 (DECISION_LOG 6bff30e: detection fails closed). */

const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    legalName: 'Legal',
    domain: 'Domain',
    website: 'Website',
    town: 'Town',
    country: 'Country',
    careersUrl: 'Careers',
  },
});
const row = (over: Record<string, string>) => ({
  Company: 'Acme Widgets Ltd',
  Legal: '',
  Domain: '',
  Website: '',
  Town: '',
  Country: 'GB',
  Careers: '',
  ...over,
});
const map = (over: Record<string, string>) => mapDirectoryRow(config, row(over), 2);
const kept = (over: Record<string, string>) => {
  const r = map(over);
  if ('error' in r) throw new Error(`row refused: ${r.error.code}`);
  return r;
};

describe('(1) URL cells (as amended by DECISION_LOG 29b6592: reduced, not parsed)', () => {
  it.each([
    'https://jane.at/gmail.com',
    'https://jane.smith.at/gmail.com',
    'https://jane-smith.at/gmail/dot/com',
    'https://www.jane.at/gmail.co.uk',
    'https://jane.at/gmail.com/careers',
    'https://jobs-at-acme.com/careers',
  ])('%s is dropped as the careers URL and as the website; the row stays', (u) => {
    expect(reduceUrlCell(u).kind).toBe('contact');
    const r = kept({ Careers: u, Website: u });
    expect(r.candidate.payload.careersUrl).toBeNull();
    expect(r.warnings.map((w) => w.column).sort()).toEqual(['Careers', 'Website']);
  });

  it.each([
    ['https://jane.com./at/gmail.com', 'https://jane.com/'],
    ['https://careers.acme.co.uk/jobs/jane-at-gmail', 'https://careers.acme.co.uk/'],
    ['https://careers.acme.co.uk/jobs/(a)/x', 'https://careers.acme.co.uk/'],
  ])('%s is reduced to its origin %s', (u, origin) => {
    expect(kept({ Careers: u }).candidate.payload.careersUrl).toBe(origin);
  });

  it.each(['https://acme.at/jobs', 'https://acme.at/de/jobs/senior-engineer', 'https://www.acme.at/'])(
    'an Austrian careers page %s keeps its path',
    (u) => {
      expect(kept({ Careers: u }).candidate.payload.careersUrl).toBe(u);
    },
  );
});

describe('(2) the address search fails closed', () => {
  const exhausting = `x at ${'a.'.repeat(1000)}`.slice(0, 1995);
  it('a text the bounded search cannot decide is undecidable: the name refuses the row, an optional cell is dropped', () => {
    expect(contactValueVerdict(exhausting)).toBe('undecidable');
    expect(hasContactValue(exhausting)).toBe(true);
    expect(map({ Company: exhausting })).toMatchObject({ error: { code: 'contact_value_undecidable' } });
    expect(kept({ Legal: exhausting }).warnings[0]).toMatchObject({ code: 'contact_value', column: 'Legal' });
  });

  it('the re-verification #13 shape (a first label over 63 characters) is pruned, not searched', () => {
    const shape = `j at ${'x'.repeat(70)}${' dot'.repeat(470)}`.slice(0, 1995);
    expect(contactValueVerdict(shape)).toBe('none');
    const t = performance.now();
    contactValueVerdict(shape, { digitRuns: true });
    expect(performance.now() - t).toBeLessThan(50);
  });

  it('a decidable address is still a contact value', () => {
    expect(contactValueVerdict('jane at acme dot com')).toBe('contact');
  });
});

describe('L-a: handle-shaped tokens', () => {
  it.each([
    'Signal e.V.',
    'Signal K.K.',
    'Signal s.r.o.',
    'Slack d.o.o.',
    'Signal A.Ş.',
    'Signal P.C.',
    'Viber S.à r.l.',
    'Signal U.K. Ltd',
    'Signal U.S.A. Inc.',
    'Slack N.Y. LLC',
    'Signal Co.Ltd',
    'Signal No.1 Ltd',
    'Snapchat 3.0 Ltd',
    'Telegram 2.0 Ventures',
    'Skype 3.14 Ltd',
    'Telegram St.Petersburg OOO',
  ])('%j is kept', (name) => {
    expect(kept({ Company: name, Legal: name }).warnings).toEqual([]);
  });

  it.each([
    'Jane skype jane.smith',
    'discord jane#1234',
    'telegram jane_smith',
    'Acme signal jane12345', // digits alone are no handle (DECISION_LOG 47c0f5c)
    'Acme whatsapp +447700900123',
    'skype jane.smith.uk',
  ])('%j is still refused', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
  });
});

describe('L-b: dot words', () => {
  it.each([
    'jane arroba gmail punto com',
    'jane at acme punkt de',
    'jane at acme point fr',
    'jane at acme ponto br',
    'jane (at) acme PUNTO es',
  ])('%j is refused', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
  });

  it.each([
    'Point Ltd',
    'Punto Banco SA',
    'Meeting Point Ltd',
    'Punkt Design GmbH',
    'Ponto Final Lda',
    'Point at Home Ltd',
    'Data Point Inc.',
  ])('%j is kept', (name) => {
    expect(kept({ Company: name }).warnings).toEqual([]);
  });
});

describe('L-c: bracket pairing (Bidi_Paired_Bracket, any two quotes)', () => {
  it.each([
    'jane ⦍a⦐ gmail.com',
    'jane 〝a〟 gmail.com',
    'jane "a" gmail.com',
    "jane 'a' gmail.com",
    'jane ⹂a“ gmail.com',
    'jane ⦏a⦎ gmail.com',
  ])('%j is refused', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
  });

  it('pairs follow BidiBrackets.txt, not code-point adjacency', () => {
    expect(bracketsPair('⦍', '⦐')).toBe(true);
    expect(bracketsPair('⦏', '⦎')).toBe(true);
    expect(bracketsPair('⦍', '⦎')).toBe(false);
    expect(bracketsPair('⦏', '⦐')).toBe(false);
    expect(bracketsPair('［', '］')).toBe(true);
    // `⦍a⦎` is no (a): the `a` is a word between brackets.
    expect(tokenizeAddress('⦍a⦎', 'separator').filter((t) => t.kind !== 'sep')).toEqual([
      { kind: 'word', text: 'a' },
    ]);
  });
});

describe('L-d: middle dots are dot-forms', () => {
  it.each(['jane at gmail · com', 'jane at gmail‧com', 'jane at gmail • com', 'jane·at·gmail·com'])(
    '%j is refused',
    (v) => {
      expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
    },
  );
});

describe('L-f: an orphan combining mark is a separator (no name-key rescue)', () => {
  it.each(['jane at acme ́dot com', 'jane ́at acme.com', 'jane at acme.́com'])(
    '%j is a contact value as text',
    (v) => {
      expect(hasContactValue(v)).toBe(true);
    },
  );
});
