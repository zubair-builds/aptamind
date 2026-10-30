import { readFileSync } from 'node:fs';
import { parse } from 'tldts';
import { describe, expect, it } from 'vitest';
import { mapDirectoryRow, parseDirectoryConfig } from './company-directory';
import { beginRow, endRow, lastRowUnits } from './contact-grammar';
import { hasContactValue } from './directory-values';

/** PR #27 re-verification #19 (DECISION_LOG ed7b71a, amending 47c0f5c). */

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
const map = (over: Record<string, string>) =>
  mapDirectoryRow(
    config,
    {
      Company: 'Acme Widgets Ltd',
      Legal: '',
      Domain: '',
      Website: '',
      Town: '',
      Country: 'GB',
      Careers: '',
      Ref: '',
      ...over,
    },
    2,
  );
const kept = (over: Record<string, string>) => {
  const r = map(over);
  if ('error' in r) throw new Error(`row refused: ${r.error.code}`);
  return r;
};
const refusedEverywhere = (v: string) => {
  const name = map({ Company: v });
  return (
    'error' in name &&
    name.error.code === 'contact_value' &&
    kept({ Legal: v }).warnings.some((w) => w.column === 'Legal' && w.code === 'contact_value') &&
    kept({ Town: v }).warnings.some((w) => w.column === 'Town')
  );
};

describe('H-1 / ruling (1): a domain is exempt only as a self-reference, away from the platform word', () => {
  // Surnames that are ICANN suffixes (the reviewer's list, filtered by the PSL).
  const SURNAMES =
    'kim wang lee li zhang liu chen yang huang zhao wu zhou xu sun ma zhu hu guo he lin gao luo zheng liang park choi jung kang cho yoon jang lim han oh seo shin kwon hwang ahn song singh kumar sharma patel shah khan ali ahmed smith jones brown taylor williams wilson johnson davies evans thomas roberts walker wright robinson thompson white hughes edwards green hall wood harris lewis martin jackson clarke clark turner hill scott cooper morris ward moore king watson baker harrison morgan young allen mitchell james anderson phillips bell parker davis miller garcia rodriguez martinez lopez gonzalez perez sanchez torres flores rivera gomez diaz cruz reyes ramos ruiz muller schmidt fischer weber meyer wagner becker koch richter klein wolf braun lange rossi russo ferrari bianchi romano ricci bruno gallo conti costa silva santos lima pereira nguyen tran le pham hoang vu dang bui do ho ngo ly ng lu mo su to black gold fox bond ford law love day rich best cook moss rose stone ray may star bush cash power sky page hunt bay wise frost dale case hope joy art fun cool pink red blue kids man dean gay hsu tan tay goh teo toh yeo koh chan lai lam yip ip au'
      .split(' ')
      .filter((s) => {
        const p = parse(`jane.${s}`, { allowPrivateDomains: false });
        return p.domain === `jane.${s}` && p.isIcann;
      });
  const FIRST = ['min', 'wei', 'jin', 'anh', 'kelvin', 'jack', 'amy', 'tom', 'jane', 'li'];
  const members = SURNAMES.flatMap((s, i) => [
    `Acme Ltd skype ${FIRST[i % FIRST.length]}.${s}`,
    `${FIRST[i % FIRST.length]}.${s} (telegram)`,
    `Acme Ltd skype id ${FIRST[i % FIRST.length]}.${s}`,
  ]);
  it(`generated: ${members.length} first.surname handles whose surname is a TLD are refused everywhere`, () => {
    expect(SURNAMES.length).toBeGreaterThan(30);
    expect(members.filter((v) => !refusedEverywhere(v))).toEqual([]);
  });

  it.each([
    'Acme skype min.kim',
    'Acme skype wei.wang',
    'WeChat: wei.wang',
    'Acme skype kelvin.ng',
    'Acme telegram jin.hu',
    'Acme skype anh.vu',
    'Acme skype tom.green',
    'Acme skype jane.schmidt',
    'Acme skype jane.com',
    'Acme telegram janedoe.io',
    'Acme skype www.janedoe.com',
    'Acme Ltd skype acme.com',
    'Signal Hill skype signalhill.com',
    // Not next to the platform word: the domain check runs, and a TLD surname is no self-reference.
    'WeChat ID: wei.wang',
    'Acme skype contact min.kim',
    'Acme telegram username janedoe.io',
    'Acme Ltd, skype id acmejane.com',
    'Acme Widgets Ltd, skype id acmewidgetsjane.com',
  ])('%j is refused as a name, legal name and town', (v) => {
    expect(refusedEverywhere(v)).toBe(true);
  });

  it.each([
    'Slack Ltd t/a Slack.com',
    'Signal AI Ltd (signal-ai.com)',
    'Signal Iduna Gruppe (signal-iduna.de)',
    'Signal Hill Corp. (SignalHill.COM)',
    'Signal Hill Corp. (www.SignalHill.com)',
    'SIGNAL HILL CORP (SIGNALHILL.COM)',
    'Kakao Corp. (kakaocorp.com)',
    'Signal Genetics Inc. (signalgenetics.com)',
    'Signal.co.uk Ltd',
  ])('self-referenced %j is kept', (v) => {
    expect(kept({ Company: v }).candidate.payload.name).toBe(v);
  });
});

describe('H-2 / ruling (2): a platform word in a URL path, query or fragment reduces it to its origin', () => {
  it.each([
    'https://acme.com/skype/jane_doe',
    'https://acme.com/telegram/jane_doe_85',
    'https://acme.com/wechat/wxid_abc123',
    'https://acme.com/contact/skype_jane_doe',
    'https://acme.com/careers/whatsapp/91234567',
    'https://acme.com/kik/jane_doe',
    'https://acme.com/careers?skype=jane.doe',
    'https://acme.com/careers#skype-jane.doe',
    'https://acme.com/careers/%73kype/jane',
  ])('Careers %s is stored as its origin, reported', (u) => {
    const r = kept({ Careers: u });
    expect(r.candidate.payload.careersUrl).toBe('https://acme.com/');
    expect(r.warnings).toContainEqual(
      expect.objectContaining({ column: 'Careers', code: 'url_reduced_to_origin' }),
    );
  });

  it('a host with a platform word stays a host (accepted residual), a plain careers path stays', () => {
    const r = kept({ Domain: 'slack.co.jp', Careers: 'https://careers.signal.co.uk/careers' });
    expect(r.candidate.payload.domain).toBe('slack.co.jp');
    expect(r.candidate.payload.careersUrl).toBe('https://careers.signal.co.uk/careers');
    expect(kept({ Careers: 'https://acme.com/careers/signals-team' }).candidate.payload.careersUrl).toBe(
      'https://acme.com/careers/signals-team',
    );
  });
});

describe('L-2 / ruling (3): 7 or more digits next to a platform word', () => {
  it.each([
    'Acme whatsapp 91234567',
    'Acme viber 5551234',
    'Acme whatsapp 555 1234',
    'Acme whatsapp 555-1234',
    'Acme whatsapp 0770.090.0123',
    'Acme signal 99999999',
    'Acme 1234567 (whatsapp)',
  ])('%j is refused', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
  });

  it.each([
    'Signal Hill Ltd (Company No. 12345678)',
    'Signal Hill Ltd (Reg. No. 01234567)',
    'Signal Hill Ltd Nr. 1234567',
    'Signal Hill Ltd #1234567',
    'Signal 88 Security LLC, Omaha NE 68102',
    'Acme signal 123456',
    'Signal Hill Ltd, 1234567 units sold',
    'Signal #1234567 Ltd',
    'Slack No. 1234567',
    'Signal Hill Ltd (Reg. No. SC123456)',
  ])('%j is kept', (v) => {
    expect(kept({ Company: v }).candidate.payload.name).toBe(v);
  });
});

describe('L-4 / ruling (4): joiner runs, alnum:alnum pairs, more joiners', () => {
  it.each([
    'Acme skype jane__doe',
    'Acme skype jane..doe',
    'Acme skype jane._doe',
    'Acme skype live:janedoe',
    'Acme skype live:jane.doe',
    'Acme telegram id:janedoe',
    'Acme skype jane٫doe',
    'Acme skype jane۔doe',
  ])('%j is refused', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
  });
});

describe('L-5 / ruling (6): more legal-form parts', () => {
  const NAMES = [
    'Kik Interactive Inc.',
    'Threema GmbH',
    'Kakao Corp.',
    'Kakao Mobility Corp.',
    'KakaoBank Corp.',
    'Kakao Games Corp.',
    'Kakao Pay Corp.',
    'Kakao Entertainment Corp.',
    'KakaoTalk Europe B.V.',
    'Twitter, Inc.',
    'Twitter International Unlimited Co.',
    'X Corp. (formerly Twitter, Inc.)',
    'Twitter UK Ltd.',
    'TWITTER UK LTD',
    'KAKAO EUROPE B.V.',
    'SLACK TECHNOLOGIES LIMITED',
    'SIGNAL AI LIMITED',
    'SIGNAL HILL TECH.LTD',
    'Signal Peak Energy, LLC',
    'Signal Mountain Nursing & Rehab',
    'Signal Garden Research Corp.',
    'Signal Theatre Co.',
    'Skype Communications SARL',
    'Kakao Corp. (kakaocorp.com)',
    'Threema GmbH, threema.ch',
    'Twitter Inc. – twitter.com',
    'Kik Interactive (kik.com)',
    'Snap Group Ltd. (snap.com)',
    'Kakao 2.0 Inc.',
    'Signal Hill Tech.Pte.Ltd',
    'Kakao i.Corp',
    'Signal A/S',
    'Signal ApS',
    'Signal Oyj',
    'Signal K.K.',
    'Signal G.K.',
    'Signal Y.K.',
    'Signal Co.,Ltd.',
    'Signal (H.K.) Ltd',
    'Signal (M) Sdn. Bhd.',
    'Signal (S) Pte. Ltd.',
    'Signal Pty.Ltd',
    'Signal Inc.dba Signal Labs',
    'Signal Ltd.T/A Signal Labs',
    'Signal GmbH.&Co.KG',
    'Signal Hill Co.Ltd.(HK)',
    "Signal Hill Int'l Ltd",
    'Signal Hill Assn.Inc.',
    'Signal Hill Mgmt.LLC',
    'Signal Hill Svcs.Inc.',
    'Signal Hill Corp.Ltd',
    'Signal Hill Ind.Co.',
    'Signal Hill Hldgs.Pte.Ltd.',
    'Signal Hill Grp.Plc',
    'Signal Hill Plc.',
    'Signal Hill Wash.Inc.',
    'Kakao Brain Corp.',
    'Twitter Japan K.K.',
    'Kik Ltd. est.2009',
    'Viber Media Sarl, Luxembourg',
    'Discord Inc. San Francisco, CA 94107',
    'Signal Hill Ltd, Suite 12345, London',
    'Slack Tech. Co.,Ltd.',
    'Telegram Tech.Ltd.',
    'Signal Hill Petroleum Inc. (NYSE: SGHL)',
    'Signal Hill Ltd (Reg. No. 01234567)',
    'Signal Hill Ltd. Reg.No.01234567',
    'Signal Hill Ltd. Co.Reg.No.01234567',
    'Signal Hill S.A. de C.V.',
    'Signal Hill Ltda.-EPP',
    'Signal Hill Srl.',
    'Signal Hill S.r.l.',
    'Signal Hill S.R.L.',
    'Signal Hill A.Ş.',
    'Signal Hill Sp.z o.o.',
    'Signal Hill Sp.j.',
    'Signal Hill Sp.k.',
    'Signal Hill s.c.',
    'Signal Hill Kft.',
    'Signal Hill e.K.',
    'Signal Hill GbR',
    'Signal Hill mbH',
    'Signal Hill Ges.m.b.H.',
    'Signal Hill Handelsges.m.b.H.',
    'Signal Hill Beteiligungs-GmbH',
    'Signal Hill AG & Co. KGaA',
    'Signal Hill Pvt.Ltd.',
    'Signal Hill (Pvt.) Ltd.',
    'Signal Hill Pte.Ltd.',
    'Signal Hill Bhd.',
    'Signal Hill Tbk.',
    'Signal Hill PT.',
    'PT. Signal Hill Tbk',
    'Signal Hill Ltd.,Co.',
    'Signal Hill Co.,Inc.',
    'Signal Hill Inc.(USA)',
    'Signal Hill Cía.Ltda.',
    'Signal Hill Soc.Coop.',
    'Signal Hill S.Coop.',
    'Signal Hill Ind.e Com.Ltda.',
    'Signal Hill Com.e Ind.Ltda.',
    'Signal Hill Ltd. (U.K.)',
    'Signal Hill Corp. dba Signal.com',
    'Signal Hill Corp. (www.SignalHill.com)',
    'Signal Hill Corp. (SignalHill.COM)',
    'Signal Hill Corp. (signalhill.com.au)',
  ];
  it(`${NAMES.length} company names with a platform word are kept (the reviewer's corpus)`, () => {
    expect(NAMES.filter((n) => 'error' in map({ Company: n }))).toEqual([]);
  });

  it('z, j and k are accepted only in the Sp. forms', () => {
    for (const v of ['Acme skype Co.z', 'Acme skype Tech.j', 'Acme skype Ltd.k'])
      expect([v, 'error' in map({ Company: v })]).toEqual([v, true]);
  });

  it('a VAT number of 9 digits is refused by the 9-digit rule for names (documented)', () => {
    expect(map({ Company: 'Signal Hill Ltd, VAT No. GB123456789' })).toMatchObject({
      error: { code: 'contact_value' },
    });
  });
});

describe('L-1 / ruling (5): a row maps the same way whatever was mapped before it', () => {
  const ROW = JSON.parse(
    readFileSync(new URL('./directory-rv19-memo-row.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;
  const outcome = () => {
    const r = map(ROW);
    const shown =
      'error' in r
        ? r.error.code
        : JSON.stringify([r.candidate.externalId, r.warnings.map((w) => `${w.column}:${w.code}`)]);
    return `${shown}|${lastRowUnits()}`;
  };
  it("the handle rule's domain parse is charged to the row budget", () => {
    const units = (handles: boolean) => {
      beginRow(1_000_000);
      hasContactValue('Slack Ltd t/a Slack.com', { handles });
      endRow();
      return lastRowUnits();
    };
    expect(units(true) - units(false)).toBeGreaterThanOrEqual(20);
  });

  it("the handle rule's token walk is charged to the row budget", () => {
    const units = (handles: boolean) => {
      beginRow(1_000_000);
      hasContactValue('Acme skype jane doe smith and sons', { handles });
      endRow();
      return lastRowUnits();
    };
    expect(units(true) - units(false)).toBeGreaterThanOrEqual(7);
  });

  it(
    'a row mapped at exactly its own budget maps the same way 2 100 times, other verdicts in between',
    { timeout: 60_000 },
    () => {
      // Repeated verdict keys within the row (one host in three cells): a memo lost mid-row would
      // charge them again and push the row over its exact budget.
      const light = {
        Company: 'Acme Widgets Ltd',
        Legal: 'Acme Widgets Limited',
        Domain: 'acme-widgets.co.uk',
        Website: 'https://acme-widgets.co.uk/',
        Careers: 'https://acme-widgets.co.uk/careers',
        Town: 'Leeds',
        Country: 'GB',
        Ref: 'R1',
      };
      mapDirectoryRow(config, light, 2);
      const exact = lastRowUnits();
      const outcomes = new Set<string>();
      for (let k = 0; k < 2100; k++) {
        hasContactValue(`filler ${k}`);
        const r = mapDirectoryRow(config, light, 2, '', exact);
        outcomes.add(
          `${'error' in r ? r.error.code : r.warnings.map((w) => w.code).join()}|${lastRowUnits()}`,
        );
      }
      expect([...outcomes]).toEqual([`|${exact}`]);
    },
  );

  it(
    'the reviewer method: one other verdict between mappings, 150 times — one outcome',
    { timeout: 60_000 },
    () => {
      const outcomes = new Set<string>();
      for (let k = 0; k < 150; k++) {
        hasContactValue(`filler ${k}`);
        outcomes.add(outcome());
      }
      expect([...outcomes]).toHaveLength(1);
    },
  );

  it(
    'the reviewer row near the budget edge maps one way whatever came before (2 100 other verdicts, other rows)',
    { timeout: 60_000 },
    () => {
      const outcomes = new Set<string>([outcome()]);
      for (let round = 0; round < 12; round++) {
        // More distinct verdicts than the old process-wide memo held (2 048), and other rows.
        for (let k = 0; k < 2100; k++) hasContactValue(`fill ${round} ${k}`);
        for (let k = 0; k < 20 * round; k++)
          map({ Company: `Other Co ${round} ${k}`, Legal: `Other Co ${k} Limited` });
        outcomes.add(outcome());
      }
      expect([...outcomes]).toHaveLength(1);
      expect(Number([...outcomes][0]!.split('|').at(-1))).toBeGreaterThan(90_000); // the row is near the edge
    },
  );
});
