import { describe, expect, it } from 'vitest';
import { mapDirectoryRow, parseDirectoryConfig } from './company-directory';
import { decodeEscapes, directoryDomain, hasContactValue } from './directory-values';

/** PR #27 re-verification #12. */

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

describe('H-1: a keyword as a local part or label', () => {
  it.each([
    'jane at at dot com',
    'jane at dot dot com',
    'dot at acme dot com',
    'arroba at acme.com',
    'vux-at arroba acme.dev',
    'bn_aT arroba acme.ελ',
    'x at 「a⟧.3026.бел',
    'zqk4 at at dot com',
  ])('%j is refused as a name and dropped as a legal name', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
    expect(kept({ Legal: v }).warnings[0]).toMatchObject({ column: 'Legal' });
  });

  it('`(a)` needs a closer that pairs with its opener: `「a⟧` is the label `a`', () => {
    expect(hasContactValue('Plan 「A⟧ Holdings Ltd')).toBe(false);
    // Read as brackets around the label `a`, this is jane@a.com.
    expect(hasContactValue('jane at 「a⟧ dot com')).toBe(true);
    expect(hasContactValue('jane at (a] dot com')).toBe(true);
  });
});

describe('M-1: (a) in reversed or mixed quote pairs', () => {
  it.each(['jane »a« acme.com', 'jane „a“ acme.com', 'jane ﴾a﴿ acme.com', 'zqk3 »a« acme.com'])(
    '%j is refused',
    (v) => {
      expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
    },
  );
});

describe('H-2: a careers URL whose host is the local part', () => {
  it.each([
    'https://jane/at/gmail.com',
    'https://jane.smith/at/gmail/./com',
    'https://j.smith/at/gmail.com/jobs',
    'jane.smith/at/gmail/dot/com',
    'https://zqk1/at/gmail.com',
  ])('%s is dropped', (careers) => {
    const r = kept({ Careers: careers });
    expect(r.candidate.payload.careersUrl).toBeNull();
    expect(r.warnings[0]).toMatchObject({ column: 'Careers' });
  });

  it('a careers host must be registrable', () => {
    expect(kept({ Careers: 'https://careers/jobs' }).candidate.payload.careersUrl).toBeNull();
    expect(kept({ Careers: 'https://careers.acme.co.uk/jobs' }).candidate.payload.careersUrl).toBe(
      'https://careers.acme.co.uk/jobs',
    );
  });

  it('the at notation in a URL path after a host label is never stored', () => {
    expect(kept({ Careers: 'https://jane.smith/at/gmail/./com' }).candidate.payload.careersUrl).toBeNull();
  });
});

describe('H-3: zero-padded numeric entities', () => {
  it.each(['jane&#00000064;acme.com', 'jane at acme&#x0000002e;com', 'zqk2&#0000064;acme.com'])(
    '%j is refused',
    (v) => {
      expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
    },
  );

  it('decodes them', () => {
    expect(decodeEscapes('jane&#00000064;acme&#x0000002e;com')).toBe('jane@acme.com');
  });
});

describe('M-2: the handle rule needs a handle-shaped token', () => {
  it.each([
    'Discord Inc.',
    'Signal 88 LLC',
    'Signal Inc.',
    'Signal Co.',
    'Signal Ltd.',
    'Signal Corp.',
    'Signal S.A.',
    'Signal B.V.',
    'Slack Inc.',
    'Telegram Ltd.',
    'Insta Inc.',
    'Insta 360 Ltd',
    'Signal 1 Security Ltd',
    'Viber 2 Co. Ltd',
    'Skype Technologies Ltd',
  ])('%j is kept', (name) => {
    expect(kept({ Company: name, Legal: name }).warnings).toEqual([]);
  });

  it.each([
    'Jane skype jane.smith',
    'discord jane#1234',
    'Acme whatsapp +447700900123',
    'telegram jane_smith',
    'Acme signal jane12345', // digits alone are no handle (DECISION_LOG 47c0f5c)
  ])('%j is still refused', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
  });
});

describe('M-3: Domain and Website must be ICANN-registrable', () => {
  it.each(['jane.smith', 'acme.notatld', 'r.wjb3n', 'zqk5.smith'])('Domain %s is dropped', (d) => {
    expect('refused' in directoryDomain(d)).toBe(true);
    const r = kept({ Domain: d, Website: `https://${d}/` });
    expect(r.candidate.payload.domain).toBeNull();
    expect(r.candidate.payload.website).toBeNull();
  });

  it('the local part of an email never becomes the domain', () => {
    const r = kept({ Domain: 'jane.smith/at/gmail.com' });
    expect(r.candidate.payload.domain).toBeNull();
  });

  it.each(['acme.co.uk', 'acme.io', 'acme.london', 'acme.com.au'])('Domain %s is kept', (d) => {
    expect(kept({ Domain: d }).candidate.payload.domain).not.toBeNull();
  });
});

describe('L-1: default-ignorable characters and orphan marks', () => {
  it.each([
    'jane a‎t acme.com',
    'jane at acme d͏ot com',
    'jane at️ acme dot com',
    'jane a⁡t acme.com',
    'jane at acme ́dot com',
  ])('%j is refused', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
  });
});

describe('L-2: a hyphen ends no profile-link host boundary', () => {
  it.each([
    'https://home-x.com/en-gb/careers/',
    'https://space-x.com/careers/jobs',
    'https://acme-fb.com/jobs/1',
  ])('%s keeps its careers URL', (careers) => {
    expect(kept({ Careers: careers }).candidate.payload.careersUrl).not.toBeNull();
  });
});
