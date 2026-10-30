import { domainToASCII, domainToUnicode } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mapDirectoryRow, parseDirectoryConfig } from './company-directory';
import { contactValueVerdict } from './directory-values';

/** PR #27 re-verification #15 (DECISION_LOG bd6ad44: check what you store). */

const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    domain: 'Domain',
    website: 'Website',
    country: 'Country',
    careersUrl: 'Careers',
  },
});
const map = (over: Record<string, string>) =>
  mapDirectoryRow(
    config,
    { Company: 'Acme Widgets Ltd', Domain: '', Website: '', Country: 'GB', Careers: '', ...over },
    2,
  );
const kept = (over: Record<string, string>) => {
  const r = map(over);
  if ('error' in r) throw new Error(`row refused: ${r.error.code}`);
  return r;
};
/** Whether a URL cell was stored in any column it was placed in. */
const stored = (u: string) => {
  const r = kept({ Website: u, Careers: u });
  return r.candidate.payload.website != null || r.candidate.payload.careersUrl != null;
};

/** A seeded 32-bit LCG (reproducible samples). */
function lcg(seed: number) {
  let s = seed;
  return () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x80000000;
}

describe('HIGH-A: the stored origin is checked, not the host as written', () => {
  const INVISIBLES = ['­', '​', '⁠', '͏', '️', '᠋', '\u{e0100}'];
  it.each([
    ...INVISIBLES.map((cp) => `https://jane-a${cp}t-gmail-dot-com.acme.com/`),
    'https://jane-a%C2%ADt-gmail-dot-com.acme.com/',
    'https://jane-a&shy;t-gmail-dot-com.acme.com/',
    'https://jane-a¡t-gmail-dot-com.acme.com/',
    'https://jane-a™t-gmail-dot-com.acme.com/',
    'https://jane-a✓t-gmail-dot-com.acme.com/',
    'https://jane-aét-gmail-dot-com.acme.com/',
    'https://jane-ẚt-gmail-dot-com.acme.com/',
    'https://jane.a¡t.gmail.com.acme.co.uk/',
    'https://jane.a¡t.gmail.com.acme.co.uk/careers',
    // Written in punycode: the host is stored as written, but its ASCII part spells the address.
    'https://xn--jane-at-gmail-dot-com-6ua.acme.com/',
    'https://jane.xn--at-4ca.gmail.com.acme.co.uk/',
  ])('%s is stored in no URL cell', (u) => {
    expect(stored(u)).toBe(false);
  });

  // Written in punycode, the ASCII part glues the at-word to its neighbours (`xn--janeatgmail-…`);
  // only the stored host's Unicode form (`jane¡at¡gmail…`) reads as the address.
  const NON_ASCII_SEPARATORS = [
    '¡',
    '¿',
    '·',
    '•',
    '«',
    '»',
    '§',
    '¶',
    '†',
    '‡',
    '†',
    '→',
    '★',
    '♦',
    '–',
    '—',
  ];
  const punycodeMembers = NON_ASCII_SEPARATORS.flatMap((sep) =>
    ['at', 'arroba'].flatMap((w) => {
      const host = domainToASCII(`jane${sep}${w}${sep}gmail.com.acme.co.uk`);
      return host ? [`https://${host}/`, `https://${host}/careers`] : [];
    }),
  );
  it(`generated: ${punycodeMembers.length} punycode-written hosts whose Unicode form is an address are stored in no URL cell`, () => {
    expect(punycodeMembers.length).toBeGreaterThan(20);
    expect(punycodeMembers.filter(stored)).toEqual([]);
  });

  it('a Domain written in punycode whose Unicode form is an address is dropped', () => {
    const r = kept({ Domain: domainToASCII('jane¡at¡gmail.com') });
    expect(r.candidate.payload.domain).toBeNull();
    expect(r.warnings).toContainEqual(expect.objectContaining({ column: 'Domain', code: 'contact_value' }));
  });

  it('a Domain whose stored (punycode) domain spells an address is dropped', () => {
    const r = kept({ Domain: 'jane-a¡t-gmail.com' });
    expect(r.candidate.payload.domain).toBeNull();
    expect(r.warnings).toContainEqual(expect.objectContaining({ column: 'Domain', code: 'contact_value' }));
  });

  it('legitimate IDN hosts are still stored (the punycode ASCII part reads as no address)', () => {
    for (const u of ['https://bücher.de/jobs', 'https://www.müller-gmbh.de/karriere', 'https://пример.рф/'])
      expect([u, stored(u)]).toEqual([u, true]);
  });

  // Generated: every word at-form × a seeded sample of code points that SURVIVE the WHATWG/IDNA
  // serialisation with the at-form intact in the stored host (the oracle reads the serialised host,
  // independent of the detector) × separators. None may be stored.
  const AT_WORDS = ['at', 'AT', 'arroba'];
  const SEPARATORS = ['-', '.'];
  const survives = (host: string, word: string, sep: string) => {
    const w = word.toLowerCase();
    const forms = [host, domainToUnicode(host)];
    for (const l of host.split('.')) if (l.startsWith('xn--')) forms.push(l.slice(4, l.lastIndexOf('-')));
    return forms.some((f) =>
      sep === '.' ? f.split('.').includes(w) : f.includes(`-${w}-`) || f.startsWith(`${w}-`),
    );
  };
  const rnd = lcg(20260930);
  const sample: number[] = [];
  while (sample.length < 400) {
    const cp = 0xa0 + Math.floor(rnd() * (0x2ffff - 0xa0));
    if (cp < 0xd800 || cp > 0xdfff) sample.push(cp);
  }
  const members: string[] = [];
  for (const word of AT_WORDS)
    for (const sep of SEPARATORS)
      for (const cp of sample) {
        const inserted = `${word.slice(0, 1)}${String.fromCodePoint(cp)}${word.slice(1)}`;
        const u = `https://jane${sep}${inserted}${sep}gmail${sep}dot${sep}com.acme.co.uk/`;
        let host: string;
        try {
          host = new URL(u).hostname;
        } catch {
          continue; // the WHATWG parser refuses the host: nothing could be stored
        }
        if (survives(host, word, sep)) members.push(u);
      }

  it(`generated: ${members.length} at-forms that survive serialisation are stored in no URL cell`, () => {
    expect(members.length).toBeGreaterThan(300);
    expect(members.filter(stored)).toEqual([]);
  });
});

describe('HIGH-A (2): an invisible code point drops a URL, Domain or Website cell', () => {
  const INVISIBLE = [
    '­', '​', '‌', '‍', '‎', '‏', '‪', '‮', '⁠', '⁦',
    '⁩', '﻿', '͏', '؜', 'ᅟ', '᠎', '︀', '️', '\u{e0001}', '\u{e0100}',
  ]; // prettier-ignore
  const encodings = (cp: string) => [
    cp,
    encodeURIComponent(cp),
    `&#x${cp.codePointAt(0)!.toString(16)};`,
    `&#${cp.codePointAt(0)};`,
  ];
  const cells = INVISIBLE.flatMap((cp) =>
    encodings(cp).flatMap((e) => [
      `https://acme${e}.co.uk/`,
      `https://acme.co.uk/jobs${e}`,
      `acme.co.uk${e}`,
    ]),
  );
  it(`${cells.length} cells with an invisible code point (as written, percent- or entity-encoded) are dropped`, () => {
    const keptCells = cells.filter((v) => {
      const r = kept({ Domain: v, Website: v, Careers: v });
      const p = r.candidate.payload;
      return p.domain != null || p.website != null || p.careersUrl != null;
    });
    expect(keptCells).toEqual([]);
  });

  it('the drop reports the column, never the cell text', () => {
    const r = kept({ Website: 'https://acme​.co.uk/' });
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'invalid_website', column: 'Website' })]);
    expect(JSON.stringify(r.warnings)).not.toContain('acme');
  });
});

describe('MEDIUM-C: domain-identity refusals read the raw cell (before origin reduction)', () => {
  it.each([
    'https://www.google.com/maps/place/Acme+Ltd',
    'https://www.google.co.uk/maps/@51.5,-0.1,15z',
    'google.co.uk/search?q=acme+widgets',
    'https://www.google.com/search?q=acme',
    'https://maps.google.com/?q=acme',
  ])('%s is no Domain and no Website', (v) => {
    const r = kept({ Domain: v, Website: v });
    expect(r.candidate.payload.domain).toBeNull();
    expect(r.candidate.payload.website).toBeNull();
    // Refused as no company domain (`@51.5,…` in a map link is also an `@`: a contact value).
    expect(r.warnings.map((w) => w.column).sort()).toEqual(['Domain', 'Website']);
    if (!v.includes('@'))
      expect(r.warnings.map((w) => w.code).sort()).toEqual(['invalid_domain', 'invalid_website']);
  });

  it('a plain company domain and website are unaffected', () => {
    const r = kept({ Domain: 'https://www.acme.co.uk/', Website: 'https://www.acme.co.uk/about' });
    expect(r.candidate.payload.domain).toBe('acme.co.uk');
    expect(r.candidate.payload.website).toBe('https://www.acme.co.uk/');
  });
});

describe('HIGH-B: the rv15 shape is bounded', () => {
  it('is decided (or fails closed) within the budget, in well under 100 ms per column', () => {
    const v = `j at a ${'point '.repeat(9)}${'ü'.repeat(64)}${'-ü'.repeat(180)}`;
    for (const x of [v, v.replace(/ /g, ' ​')]) {
      contactValueVerdict(x, { digitRuns: true });
      const t = performance.now();
      contactValueVerdict(x, { digitRuns: true });
      expect(performance.now() - t).toBeLessThan(50);
    }
  });
});

describe('Lows: company tokens after a messaging word', () => {
  it.each(['Signal v2.0', 'Signal No.1 Ltd', 'Telegram St.Petersburg OOO'])('%j is kept', (n) => {
    expect(kept({ Company: n }).warnings).toEqual([]);
  });
  it.each([
    'Acme skype v.petrov',
    'Acme skype V.PETROV',
    'Acme skype v2.petrov',
    'Acme skype nr.jansen',
    'Acme skype jane.smith',
  ])('%j is still refused', (n) => {
    expect(map({ Company: n })).toMatchObject({ error: { code: 'contact_value' } });
  });
});
