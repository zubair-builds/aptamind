import { describe, expect, it } from 'vitest';
import { lastRowUnits } from './contact-grammar';
import { DIRECTORY_ROW_BUDGET, mapDirectoryRow, parseDirectoryConfig } from './company-directory';
import { hasContactValue, urlHasContactValue } from './directory-values';

/** PR #27 re-verification #18 (DECISION_LOG 47c0f5c: handle scope; a structural per-row budget). */

const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    legalName: 'Legal',
    domain: 'Domain',
    website: 'Website',
    town: 'Town',
    country: 'Country',
    careersUrl: 'Careers',
    id: 'Ref',
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
  Ref: '',
  ...over,
});
const map = (over: Record<string, string>, budget?: number) =>
  mapDirectoryRow(config, row(over), 2, '', budget);
const kept = (over: Record<string, string>) => {
  const r = map(over);
  if ('error' in r) throw new Error(`row refused: ${r.error.code}`);
  return r;
};

describe('MEDIUM-1 / ruling (1): handles are a text-cell rule; URL and Domain cells are never scanned for them', () => {
  const HOSTS = [
    'signal-iduna.de', 'www.signal-iduna.de', 'signal.co.uk', 'careers.signal.co.uk', 'signal.com.au', 'signal-group.com.au',
    'signal-ai.com', 'signal-hill.com', 'slack.co.jp', 'slack-edge.com', 'slack-technologies.co.uk', 'telegram-group.co.uk',
    'whatsapp.co.za', 'viber-media.com', 'insta-group.fi', 'skype.com', 'discord.com', 'kik.com', 'twitter.com.au',
  ]; // prettier-ignore
  it.each(HOSTS)('%s stays Domain identity, Website and Careers URL', (h) => {
    const r = kept({ Domain: h, Website: `https://${h}/`, Careers: `https://${h}/careers` });
    expect(r.candidate.payload.domain).not.toBeNull();
    expect(r.candidate.payload.website).toBe(`https://${h}/`);
    expect(r.candidate.payload.careersUrl).toBe(`https://${h}/careers`);
  });

  it('the URL detector never reads a handle (a path or host after a platform word)', () => {
    for (const u of [
      'https://signal.co.uk/careers',
      'https://acme.com/slack/jobs',
      'https://skype.jane.doe.acme.com/',
    ])
      expect([u, urlHasContactValue(u)]).toEqual([u, false]);
    // The text detector does, when asked.
    expect(hasContactValue('Acme skype jane.doe', { handles: true })).toBe(true);
    expect(hasContactValue('Acme skype jane.doe')).toBe(false);
  });
});

describe('ruling (2): text cells — every token before and after a platform word', () => {
  it.each([
    'Acme jane.doe on skype',
    'Acme jane.doe (skype)',
    'jane.doe skype Acme Ltd',
    'Acme skype St.Jane.Doe',
    'Acme skype No.1.jane',
    'Acme skype jane・doe',
    'Acme skype jane･doe',
    'Acme skype jane∙doe',
    'Acme skype jane⋅doe',
    'Acme skype jane⸱doe',
    'Acme skype jane᛫doe',
    'Acme skype janeꞏdoe',
    'Acme skype jane⸳doe',
    'Acme kik jane.doe',
    'Acme threema jane.doe',
    'Acme kakao jane.doe',
    'Acme kakaotalk jane.doe',
    'Acme twitter jane.doe',
    'Acme signal co.ltd',
    'Acme skype mr.jones',
    'Discord Holdings Ltd., c/o Mr.Brown',
    'Acme skype jane.smith.uk',
    'ACME LTD SKYPE BOB.KIM',
    'Acme signal jane12345',
    'Slack E.ON SE',
  ])('%j is refused as a name, legal name and town', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
    expect(kept({ Legal: v }).warnings[0]).toMatchObject({ column: 'Legal', code: 'contact_value' });
    expect(kept({ Town: v }).warnings.some((w) => w.column === 'Town')).toBe(true);
  });

  it.each([
    'Acme line jane.doe',
    'Acme wire jane.doe',
    'Acme teams jane.doe',
    'Acme session jane.doe',
    'Acme element jane.doe',
    'Acme zoom jane.doe',
  ])('%j: not a platform word (a common word), so no handle rule', (v) => {
    expect(kept({ Company: v }).candidate.payload.name).toBe(v);
  });

  // The reviewer's corpus of real company names with a platform word (all kept).
  const NAMES = [
    'Line Corporation',
    'LINE Corporation',
    'Zoom Video Communications, Inc.',
    'Wire Rope Ltd',
    'Signal Hill',
    'Teams 2.0 Ltd',
    'Session Beer Co.',
    'Element 14 Ltd',
    'Line 6 Inc.',
    'Wire & Cable Co. Ltd',
    'Signal Hill Petroleum, Inc.',
    'Signal Iduna Gruppe',
    'Signal Iduna Allgemeine Versicherung a.G.',
    'Signal Hill Capital Pte. Ltd.',
    'Slack Technologies, LLC',
    'Slack Technologies Ltd.',
    'Slack Technologies GmbH & Co.KG',
    'Telegram Messenger Inc.',
    'Telegram FZ-LLC',
    'WhatsApp LLC',
    'WhatsApp Ireland Ltd.',
    'Skype Communications S.a.r.l.',
    'Skype Technologies S.A.',
    'Viber Media S.à r.l.',
    'Discord Inc.',
    'WeChat Pay HK Ltd',
    'Snapchat Inc.',
    'Snap Inc.',
    'Insta Group Oy',
    'Instagram, LLC',
    'Signal Messenger, LLC',
    'Signal Technology Foundation',
    'Signal AI Ltd',
    'Signal Genetics Inc. (signalgenetics.com)',
    'Signal U.S.A. Inc.',
    'Signal Co.Ltd',
    'Signal No.1 Ltd',
    'Telegram St.Petersburg OOO',
    'Signal v2.0',
    'Snapchat 3.0 Ltd',
    'Signal Hill Ventures L.P.',
    'Signal Hill Wealth Mgmt. Inc.',
    'WeChat (Shenzhen) Tech.Co.,Ltd.',
    'Tencent WeChat Technology (Shenzhen) Co.,Ltd.',
    'Signal Media Pvt.Ltd',
    'Slack Tech Sdn.Bhd.',
    'Signal Group GmbH & Co. KGaA',
    'Insta360',
    'Signal 88 LLC',
    'Signal 88 Security LLC, Omaha NE 68102',
    'Signal Hill Ltd, Unit 12345',
    'Signal Hill Dental P.C.',
    'Signal Mountain Ltd. dba J.J. Services',
    'Slack Ltd t/a Slack.com',
    'Signal Box Café & Bar Ltd',
    'Signal Hill Winery (est. 1990) Ltd.',
    'Signal Brands Ltd (formerly Acme Co.)',
    'Signal Point Corp, Dept.Sales',
    'Signal Hill Asset Mgmt.Co.',
    'Viber Media S.à r.l. Lux.',
    'Signal Iduna Lebensversicherung a.G., Joseph-Scherer-Str. 3',
    'Signal Hill Inc. – www.signalhill.com',
    'Signal Transportation (U.K.) Ltd.',
    'Telegram Group Inc. & Telegram Messenger LLP',
    'Signal Hill Energy AG, Zweigniederlassung Zürich',
    'Slack Technologies (Wash.) Inc.',
    'Signal Advisors Inc. (Calif.)',
    'Signal Financial FCU',
    'Signal Hill Ltd (No.2)',
    'Signal Hill Ltd No. 2',
    'Signal Hill Ltd (Company No. 12345678)',
    'Insta Group Oy Ab',
    'WhatsApp Inc. i.L.',
    'Signal St. Louis Inc.',
    'Signal Ft.Worth Inc.',
    'Signal Mt.Everest Ltd',
    'Signal Hill Ltd Pty.Ltd.',
    'Signal Hill Ltd. P.Ltd.',
    'Signal AB publ.',
    'Skype Ireland Ltd. (Dublin 2)',
    'Snapchat Group Ltd. est.2011',
    'Telegram Co. K.K.',
    'Slack Japan K.K.',
    'Signal Brasil Ltda.',
    'Signal Brasil Comércio Ltda.-ME',
    'Signal Mexico S. de R.L. de C.V.',
    'Signal Chile SpA',
    'Signal S.p.A.',
    'Signal SpA',
    'Signal Colombia S.A.S.',
    'Signal Ltd. Şti.',
    'Signal Tic.Ltd.Şti.',
    'Signal Sanayi ve Ticaret A.Ş.',
    'Signal Hill Sp. z o.o.',
    'Signal Hill s.r.o.',
    'Signal Hill d.o.o.',
    'Signal Hill Kft.',
    'Signal Hill Zrt.',
    'Signal OÜ',
    'Signal UAB',
    'Signal SIA',
    'Signal Hill Pte.Ltd.',
    'Signal Hill Pvt.Ltd.',
    'Signal Hill Co.,Ltd.',
    'Signal Hill Sdn.Bhd.',
    'Signal Hill Tech.Ltd',
    'Signal Hill Int.Ltd',
    'Signal Hill Intl.Ltd.',
    'Signal Hill Grp.Ltd.',
    'Signal Hill Hldgs.Ltd.',
    'Signal Hill Mfg.Co.',
    'Signal Hill Bros.Inc.',
    'Signal Hill & Sons Co.',
    'Telegram Hill Ass.Ltd',
  ];
  it(`${NAMES.length} company names with a platform word, abbreviations, legal forms, domains and numbers are kept`, () => {
    const refused = NAMES.filter((n) => 'error' in map({ Company: n }));
    expect(refused).toEqual([]);
  });

  it.each([
    'Signal Hill Tech.Ltd',
    'Signal Hill Mfg.Co.',
    'Signal Hill Bros.Inc.',
    'Signal Hill Hldgs.Ltd.',
    'Signal Point Corp, Dept.Sales',
    'Acme Ltd c/o Mr.Brown',
    'Snapchat Group Ltd. est.2011',
    'Slack Ltd t/a Slack.com',
    'Signal 88 Security LLC, Omaha NE 68102',
    'Signal Hill Ltd (Company No. 12345678)',
    'Signal Iduna Gruppe (signal-iduna.de)',
    'Signal AI Ltd (signal-ai.com)',
    'Signal.co.uk Ltd',
    'Signal Tic.Ltd.Şti.',
    'Acme signal 12345',
    'Telegram St.Petersburg OOO',
    'Signal No.1 Ltd',
  ])('%j is kept', (v) => {
    expect(kept({ Company: v }).candidate.payload.name).toBe(v);
  });

  // Generated: platforms × positions × handle shapes (refused) and × company tokens (kept).
  const PLATFORMS = [
    'skype',
    'Telegram',
    'WHATSAPP',
    'signal',
    'kik',
    'threema',
    'kakao',
    'twitter',
    'discord',
    'slack',
  ];
  const HANDLES = [
    'jane.doe',
    'TOM.LEE',
    'jane·doe',
    'jane・doe',
    'jane_doe',
    'j.doe99',
    'St.Jane.Doe',
    'No.1.jane',
    'jane.smith.uk',
  ];
  // (Domains are exempt only as a self-reference away from the platform word: DECISION_LOG ed7b71a.)
  const COMPANY = [
    'Tech.Ltd',
    'Mfg.Co.',
    'Hldgs.Ltd.',
    'Co.KG',
    'Pte.Ltd.',
    'S.A.',
    'est.2011',
    'No.2',
    'St.Petersburg',
    '68102',
    'v2.0',
  ];
  const place = (p: string, t: string) => [`Acme ${p} ${t}`, `Acme ${t} (${p})`, `${t} on ${p} Ltd`];
  const refusedMembers = PLATFORMS.flatMap((p) => HANDLES.flatMap((h) => place(p, h)));
  const keptMembers = PLATFORMS.flatMap((p) => COMPANY.flatMap((t) => place(p, t)));
  it(`generated: ${refusedMembers.length} handles before or after a platform word are refused`, () => {
    expect(refusedMembers.filter((v) => !('error' in map({ Company: v })))).toEqual([]);
  });
  it(`generated: ${keptMembers.length} company tokens before or after a platform word are kept`, () => {
    expect(keptMembers.filter((v) => 'error' in map({ Company: v }))).toEqual([]);
  });
});

describe('MEDIUM-2 / ruling (3): a structural per-row work budget', () => {
  it('a typical row uses a tiny fraction of the budget', () => {
    kept({
      Legal: 'Acme Widgets Limited',
      Domain: 'acme.co.uk',
      Town: 'Manchester',
      Careers: 'https://careers.acme.co.uk/jobs',
    });
    expect(lastRowUnits()).toBeGreaterThan(0);
    expect(lastRowUnits()).toBeLessThan(DIRECTORY_ROW_BUDGET / 100);
  });

  it('a name that exhausts the budget refuses the row as undecidable, deterministically', () => {
    for (let k = 0; k < 3; k++) {
      expect(map({ Company: 'Acme Widgets Ltd' }, 1)).toMatchObject({
        error: { code: 'contact_value_undecidable' },
      });
      expect(lastRowUnits()).toBe(1);
    }
  });

  it('once the budget is spent the remaining cells are dropped (fail closed), the same way every time', () => {
    const heavy = [...`Acme ${'&amp;'.repeat(380)}`].join('⁠').slice(0, 1990);
    const cells = {
      Legal: heavy,
      Town: heavy,
      Ref: heavy,
      Website: `https://acme.com/${heavy}`,
      Careers: `https://acme.com/${heavy}`,
    };
    const runs = [0, 1, 2].map(() => {
      const r = map(cells);
      if ('error' in r) return r.error.code;
      return JSON.stringify([r.candidate.payload.legalName, r.warnings.map((w) => `${w.column}:${w.code}`)]);
    });
    expect(new Set(runs).size).toBe(1);
    // With a budget that runs out after the name, every later detector cell is dropped.
    const r = map({ Legal: 'Acme Widgets Limited', Town: 'Leeds', Ref: 'R1' }, 400);
    if ('error' in r) throw new Error(r.error.code);
    expect(lastRowUnits()).toBeLessThanOrEqual(400);
  });

  it('with a small budget, cells after the point of exhaustion are dropped as contact_value', () => {
    // Find the smallest budget that still admits the name, then the next cell is undecidable.
    let budget = 1;
    while ('error' in map({ Company: 'Acme Widgets Ltd' }, budget)) budget++;
    const r = map({ Legal: 'Acme Widgets Limited, a company registered in England' }, budget);
    if ('error' in r) throw new Error(r.error.code);
    expect(r.candidate.payload.legalName).toBe('Acme Widgets Ltd');
    expect(r.warnings).toContainEqual(expect.objectContaining({ column: 'Legal', code: 'contact_value' }));
  });
});

describe('ruling (4): more map and search hosts are never identity', () => {
  it.each([
    'map.baidu.com',
    'maps.here.com',
    'waze.com',
    'www.waze.com',
    '2gis.ru',
    'startpage.com',
    'ecosia.org',
    'search.brave.com',
    'ask.com',
    'www.ask.com',
  ])('%s is no Domain and no Website', (h) => {
    const r = kept({ Domain: h, Website: `https://${h}/` });
    expect([r.candidate.payload.domain, r.candidate.payload.website]).toEqual([null, null]);
  });
});
