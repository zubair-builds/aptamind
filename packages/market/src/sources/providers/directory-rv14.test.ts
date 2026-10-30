import { describe, expect, it } from 'vitest';
import { mapDirectoryRow, parseDirectoryConfig } from './company-directory';
import { addressGrammarVerdict } from './contact-grammar';
import { contactValueVerdict, reduceUrlCell } from './directory-values';

/** PR #27 re-verification #14 (DECISION_LOG 29b6592: URL cells are reduced, not parsed). */

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

describe('HIGH-1: no prune hides a valid reading (hyphen cuts before any length check)', () => {
  it.each([
    `jane at smith-consult.com-${'a'.repeat(70)}`,
    `jane at acme-group.de-${'x'.repeat(64)}`,
    `jane (a) smith-consult.com-${'q'.repeat(70)}`,
    `jane at my-firm.de-${'z'.repeat(70)}`,
    `jane at acme-group.com${'-a1'.repeat(30)}`,
  ])('%j is refused as a name and dropped as a legal name and town', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
    expect(kept({ Legal: v }).warnings[0]).toMatchObject({ code: 'contact_value', column: 'Legal' });
    expect(kept({ Town: v }).warnings[0]).toMatchObject({ column: 'Town' });
  });

  // Property: every generated address with a long hyphenated tail is still a contact value.
  const labels = ['acme', 'smith-consult', 'my-firm', 'mail.acme-group', 'bücher'];
  const suffixes = ['com', 'de', 'co.uk', 'io', 'xn--p1ai'];
  const tails = [1, 10, 62, 63, 64, 70, 200].flatMap((n) => [
    `-${'a'.repeat(n)}`,
    '-a1'.repeat(Math.ceil(n / 3)),
  ]);
  const members = labels.flatMap((l) =>
    suffixes.flatMap((s) =>
      tails.flatMap((t) => [
        `jane at ${l}.${s}${t}`,
        `jane(a)${l}.${s}${t}`,
        `jane arroba ${l} dot ${s}${t}`,
      ]),
    ),
  );
  it(`${members.length} generated addresses with long hyphenated tails are all contact values`, () => {
    expect(members.filter((v) => contactValueVerdict(v, { digitRuns: true }) !== 'contact')).toEqual([]);
  });

  it('labels are measured in punycode: a 60-letter IDN label is too long once encoded', () => {
    const idn = 'ü'.repeat(60); // xn--… of 60 ü is far over 63 characters
    expect(addressGrammarVerdict(`jane at ${idn}.de`)).toBe('none');
    expect(addressGrammarVerdict(`jane at ${'ü'.repeat(20)}.de`)).toBe('match');
    // The detector also reads the skeleton (DECISION_LOG 64d97b4), where `ü` is `u`: a 60-letter
    // label, so the cell fails closed.
    expect(contactValueVerdict(`jane at ${idn}.de`)).toBe('contact');
  });
});

describe('HIGH-2: URL cells are reduced to their origin unless the path is plain', () => {
  it.each([
    ['https://jane.at/%23gmail.com', 'https://jane.at/', true],
    ['https://jane.at/%23/gmail.com', 'https://jane.at/', true],
    ['https://jane.smith.at/%23/gmail.com', 'https://jane.smith.at/', true],
    ['https://jane.co.at/%23gmail.com', 'https://jane.co.at/', true],
    ['https://jane.at/%23gmail(dot)com', 'https://jane.at/', true],
    ['https://jane.at/%23gmail/dot/com', 'https://jane.at/', true],
    ['https://jane.at/%2523gmail(dot)com', 'https://jane.at/', true],
    ['https://jane.at/x&num;gmail(dot)com', 'https://jane.at/', true],
    ['https://acme.co.uk/jobs%23jane-at-gmail', 'https://acme.co.uk/', true],
    ['https://www.omv.at/de-at/karriere', 'https://www.omv.at/', true],
    ['https://www.redbull.com/at-de/jobs', 'https://www.redbull.com/', true],
    ['https://careers.acme.co.uk/jobs/index.html', 'https://careers.acme.co.uk/', true],
    ['HTTPS://Careers.ACME.co.uk/jobs?x=1#y', 'https://careers.acme.co.uk/jobs', false],
    ['https://careers.acme.co.uk:8443/jobs', 'https://careers.acme.co.uk:8443/jobs', false],
    ['https://careers.acme.co.uk:443/jobs', 'https://careers.acme.co.uk/jobs', false],
  ])('careers %s is stored as %s (reduced: %s)', (u, stored, reduced) => {
    const r = kept({ Careers: u });
    expect(r.candidate.payload.careersUrl).toBe(stored);
    const warning = expect.objectContaining({ code: 'url_reduced_to_origin', column: 'Careers' });
    if (reduced) expect(r.warnings).toContainEqual(warning);
    else expect(r.warnings).not.toContainEqual(warning);
  });

  it.each([
    'https://jane.at/gmail.com',
    'https://jane.at/gmail/dot/com',
    'https://jane.at/gmail.com/careers',
    'https://at.com/',
    'https://www.at.at/',
  ])('%s is dropped (a fail-closed host rule)', (u) => {
    expect(reduceUrlCell(u).kind).toBe('contact');
    const r = kept({ Careers: u, Website: u });
    expect(r.candidate.payload.careersUrl).toBeNull();
    expect(r.candidate.payload.website).toBeNull();
  });

  it('the query and fragment are never stored; a plain path is', () => {
    expect(reduceUrlCell('https://acme.co.uk/careers/senior-engineer?utm=x#top')).toMatchObject({
      kind: 'url',
      url: 'https://acme.co.uk/careers/senior-engineer',
      reduced: false,
    });
  });
});

describe('HIGH-3: handle exemptions only for single letters, versions and legal forms', () => {
  it.each([
    'Acme skype v.petrov',
    'Acme telegram v.ivanov',
    'Acme skype dr.smith',
    'Acme skype mr.jones',
    'Acme skype ms.lee',
    'Acme skype st.john',
    'Acme skype nr.jansen',
    'Acme signal co.ltd',
  ])('%j is refused', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
  });

  it.each([
    'Telegram St.Petersburg OOO',
    'Signal No.1 Ltd',
    'Signal Co.Ltd',
    'Signal e.V.',
    'Skype 3.14 Ltd',
    'Signal Mt.Everest Ltd',
  ])('%j is kept', (name) => {
    expect(kept({ Company: name }).warnings).toEqual([]);
  });
});

describe('the "X at Y Point Ltd" family (documented over-refusal, precise)', () => {
  it.each([
    'West Point at Harbour Point Ltd',
    'Bar at Pier Point Ltd',
    'Coffee at Home Point Cafe',
    'Lunch at Noon Punkt GmbH',
    'Rooms at Harbour Point Hotel',
    'Tea at Polka Point Co',
  ])('%j (W at L D S, S an ICANN suffix) is refused', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
  });

  it.each([
    'Canary Wharf at One Canada Point Ltd',
    'Studio at Mill Point Plc',
    'Tea at Polka Pointe Ltd',
    'Point at Harbour Ltd',
  ])('%j (two words, a non-suffix last word, or no dot word) is kept', (v) => {
    expect(kept({ Company: v }).warnings).toEqual([]);
  });
});
