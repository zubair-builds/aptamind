import { describe, expect, it } from 'vitest';
import { mapDirectoryRow, parseDirectoryConfig } from './company-directory';
import { hasContactValue, urlHasContactValue } from './directory-values';

/** DECISION_LOG "Directory import: contact detection has no exemptions" (PR #27 rv8, 621f14c). */

const config = parseDirectoryConfig({
  columns: { name: 'Company', legalName: 'Legal', town: 'Town', country: 'Country', careersUrl: 'Careers' },
});
const row = (over: Record<string, string>) => ({
  Company: 'Acme Widgets Ltd',
  Legal: '',
  Town: '',
  Country: 'GB',
  Careers: '',
  ...over,
});
const map = (over: Record<string, string>) => mapDirectoryRow(config, row(over), 2);
const careersOf = (over: Record<string, string>) => {
  const r = map(over);
  if ('error' in r) throw new Error(`row refused: ${r.error.code}`);
  return r.candidate.payload.careersUrl;
};

describe('H-1: no legal-form exemption — every spelled-dot address on a public suffix is an email', () => {
  it.each([
    'jane at acme dot co',
    'jane at acme dot com',
    'jane at acme dot co dot uk',
    'jane at acme dot ag',
    'jane at acme dot as',
    'jane at acme dot inc',
    'jane at acme dot ltd',
    'jane at acme dot llc',
    'jane at acme dot gmbh',
    'jane at acme dot bv',
    'jane [at] acme [dot] co',
    'jane (at) acme (dot) co',
    'jane [at] acme dot co',
    'jane at acme [dot] co',
    'jane at acme.co',
    'jane at acme . co',
    'jane AT acme DOT co',
    'jane-at-acme-dot-co',
    'jane_at_acme_dot_co',
    'jane at acme dot co.',
    'jane at acme dot company',
    'jane at acme dot limited',
    'jane at acme dot spa',
    'jane at acme dot srl',
    'jane at acme dot sarl',
    'jane at acme dot co dot',
    'jane at acme-corp dot co',
    'contact jane at acme dot co today',
    'jane at acme dot co, ltd',
    'jane at acme dot co (UK)',
    'jane at acme  dot  co',
    'jane at\tacme dot co',
    'jane at acme dot co',
    'jane at acme dot cO',
    'jane at acme dot Co.',
    'jane at mail dot acme dot co',
    'jane at acme dot com dot co',
    'jane at acme dot co dot ltd',
    'jane at acme dot ltd dot uk',
    'jane at acme dot plc dot uk',
    'jane at acme dot pty dot au',
    'jane at acme dot com dot au',
    'jane at acme dot net dot au',
    'jane at acme dot kg',
    'jane at acme dot llp',
    'Jane Smith at Acme dot co',
    'jane＠acme.co',
    'jane&#64;acme.co',
    'jane%40acme.co',
    'jane&commat;acme.co',
    'jane (a) acme.co',
    'jane [@] acme.co',
    'jane{at}acme{dot}co',
    'jane<at>acme<dot>co',
    'jane [ at ] acme [ . ] co',
    'jane(at)acme(.)co',
    'jane[at]acme[.]co',
    'jane at acme (.) co',
    'jane at acme [.] co',
    'jane at acme {.} co',
    'jane at acme <.> co',
    'jane at acme<.>co',
    'jane arroba acme dot co',
    'jane arroba acme dot com',
    'jane [arroba] acme [dot] com',
    'jane at acme dot co dot jp',
    'jane at acme dot or dot jp',
    'jane at acme dot ac dot uk',
    'jane at acme. co',
    'jane at acme .co',
    'jane at acme .com',
    'jane (at) acme dot co',
    'jane(at)acme dot com',
    'JANE AT ACME DOT CO',
  ])('%j is a contact value', (v) => {
    expect(hasContactValue(v, { digitRuns: true })).toBe(true);
  });

  it.each([
    'jane at acme dot lp',
    'jane at acme dot nv',
    'jane at acme dot oy',
    'jane at acme dot cic',
    'jane at acme dot corp',
    'jane at acme dot pty',
    'jane at acme d0t com',
    'jane at acme dotcom',
    'jane at acmedotcom',
  ])('documented residual %j (no public suffix, or no dot notation) is not detected', (v) => {
    expect(hasContactValue(v, { digitRuns: true })).toBe(false);
  });

  it.each([
    'Tea at Polka dot Ltd',
    'Coffee at Home dot Co',
    'Meet at Acme dot Inc',
    'Tea at Polka dot Cafe',
    'Eat at Joe dot Shop',
  ])('documented over-refusal: name %j is refused', (name) => {
    expect(map({ Company: name })).toMatchObject({ error: { code: 'contact_value' } });
  });

  it.each([
    'https://x.co.uk/careers/jane-at-acme-dot-co',
    'https://ra9.co.uk/careers/zqa9-at-acme-dot-co',
    'https://acme.co.uk/jobs/jane-arroba-acme-dot-co',
  ])('careers URL %s keeps no path (reduced to its origin, DECISION_LOG 29b6592)', (careers) => {
    expect(urlHasContactValue(careers)).toBe(true);
    expect(careersOf({ Careers: careers })).toBe(`${new URL(careers).origin}/`);
  });
});

describe('H-2: URL paths are scanned raw first; only a trailing LinkedIn id is set aside', () => {
  it.each([
    'https://www.linkedin.com/company/07700900766',
    'https://www.linkedin.com/jobs/view/07700900123',
    'https://www.linkedin.com/jobs/view/zqa6-at-acme-dot-com-3912345678',
    'https://www.linkedin.com/jobs/view/call-07700-900-877-3912345678',
    'https://www.linkedin.com/jobs/view/jane-at-acme-dot-co-3912345678/',
    // Not LinkedIn-shaped ids: a leading 0, more than 12 digits, or a phone-shaped segment.
    'https://www.linkedin.com/company/0123456789',
    'https://www.linkedin.com/company/1234567890123',
    'https://www.linkedin.com/jobs/view/senior-engineer-0123456789',
    'https://www.linkedin.com/jobs/view/senior-engineer-12345678901234',
  ])('%s is dropped', (careers) => {
    expect(urlHasContactValue(careers)).toBe(true);
    expect(careersOf({ Careers: careers })).toBeNull();
  });

  it.each([
    'https://www.linkedin.com/company/104567890/jobs/',
    'https://www.linkedin.com/jobs/view/3912345678/',
    'https://www.linkedin.com/jobs/view/senior-engineer-at-acme-3912345678',
  ])('%s is kept', (careers) => {
    expect(urlHasContactValue(careers)).toBe(false);
  });

  it('the LinkedIn id rule applies only on linkedin.com', () => {
    expect(urlHasContactValue('https://acme.co.uk/company/104567890')).toBe(true);
  });
});

describe('M-2: the name digit rule is exactly 9+ digits across non-letters', () => {
  it.each(['9123-4567 Québec inc.', '9123 4567 Québec inc.', 'Acme 555-0123 Ltd', 'Smith 020 7946'])(
    '%j (fewer than 9 digits) is kept as a name (7- and 8-digit runs are documented residuals)',
    (name) => {
      const r = map({ Company: name });
      expect('error' in r ? r.error : r.warnings).toEqual([]);
    },
  );

  it.each(['Acme 020 7946 0958 Ltd', '1 2 3 4 5 6 7 8 9 Ltd', 'Acme 770-090-0123'])(
    '%j is refused',
    (name) => {
      expect(map({ Company: name })).toMatchObject({ error: { code: 'contact_value' } });
    },
  );

  it('the town keeps its no-digit rule', () => {
    const r = map({ Town: 'Leeds 2' });
    expect('error' in r ? r.error : r.warnings[0]).toMatchObject({ column: 'Town' });
  });
});
