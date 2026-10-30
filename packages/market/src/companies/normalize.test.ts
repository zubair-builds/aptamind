import { describe, expect, it } from 'vitest';
import {
  basicNormalize,
  basicNormalizeV1,
  companyDomain,
  looseNameKeysForLookup,
  strictNameKeysForLookup,
  strictNameKeyV1,
  jaroWinkler,
  looseNameKey,
  registrableDomain,
  splitTradingName,
  strictNameKey,
} from './normalize';

describe('company name normalisation', () => {
  it('maps legal-form variants to the same strict key', () => {
    expect(strictNameKey('ACME LIMITED')).toBe('acme ltd');
    expect(strictNameKey('Acme Ltd.')).toBe('acme ltd');
    expect(strictNameKey('The Acme Ltd')).toBe('acme ltd');
    expect(strictNameKey('Smith & Sons Public Limited Company')).toBe('smith and sons plc');
    expect(strictNameKey('Café Zoë Ltd')).toBe('cafe zoe ltd');
  });

  it('keeps different legal forms distinct in strict key but equal in loose key', () => {
    expect(strictNameKey('Acme Ltd')).not.toBe(strictNameKey('Acme Inc'));
    expect(looseNameKey('Acme Ltd')).toBe('acme');
    expect(looseNameKey('Acme Inc.')).toBe('acme');
    expect(looseNameKey('Acme Holdings Ltd')).toBe('acme holdings');
  });

  it('separates trading names', () => {
    expect(splitTradingName('Acme Ltd t/a Acme Coffee')).toEqual({
      legal: 'Acme Ltd',
      tradingAs: 'Acme Coffee',
    });
    expect(strictNameKey('Acme Ltd T/A Acme Coffee')).toBe('acme ltd');
  });

  it('derives registrable domains and rejects platform domains', () => {
    expect(registrableDomain('https://www.careers.acme.co.uk/jobs')).toBe('acme.co.uk');
    expect(registrableDomain('ACME.com')).toBe('acme.com');
    expect(registrableDomain('10.0.0.1')).toBeNull();
    expect(companyDomain('https://uk.linkedin.com/company/acme')).toBeNull();
    expect(companyDomain('boards.greenhouse.io/acme')).toBeNull();
  });

  it('scores fuzzy similarity', () => {
    expect(jaroWinkler('acme analytics', 'acme analytic')).toBeGreaterThan(0.95);
    expect(jaroWinkler('acme', 'zenith')).toBeLessThan(0.6);
  });

  it('keeps letters of every script (name-norm/2): non-Latin names never collapse to an empty key (A-M3)', () => {
    expect(strictNameKey('ООО «Ромашка»')).toBe('ооо ромашка');
    expect(strictNameKey('ПАО Сбербанк')).toBe('пао сбербанк');
    expect(strictNameKey('ООО Ромашка')).not.toBe(strictNameKey('ООО Лютик'));
    expect(strictNameKey('東京電力')).toBe('東京電力');
    expect(strictNameKey('東京電力')).not.toBe(strictNameKey('関西電力'));
    expect(strictNameKey('トヨタ自動車')).toBe('トヨタ自動車');
    // NFKC: half-width katakana and full-width Latin fold to their standard forms.
    expect(strictNameKey('ﾄﾖﾀ')).toBe(strictNameKey('トヨタ'));
    expect(strictNameKey('ＡＣＭＥ Ｌｔｄ')).toBe('acme ltd');
    // Marks on non-Latin letters are part of the letter (が ≠ か); casefolding applies to Greek.
    expect(basicNormalize('が')).not.toBe(basicNormalize('か'));
    expect(strictNameKey('ΩΜΕΓΑ Ltd')).toBe(strictNameKey('ωμεγα ltd'));
    expect(strictNameKey('شركة أرامكو')).not.toBe('');
  });

  // The literal name-norm/1 function (not the exported copy), so a change to either is caught.
  const v1 = (input: string) =>
    input
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, k) => String.fromCodePoint(from + k));
  // Latin, punctuation, Latin diacritics, ŉ, modifier letters U+02B9–U+02EE and combining marks
  // outside U+0300–U+036F (the widened pool of the PR #27 re-verification).
  const LATIN_POOL = [
    ..."abcXYZ019 &'’`.,-()/éèüöçñÅøßæœłİıﬁ１Ａŉǅªºʰˡ́̈",
    ...range(0x2b9, 0x2ee),
    ...['҃', '֑', '़', '᪰', '᷀', '᷿', '⃐', '⃣', '〪', '︠'],
  ];
  const generate = (pool: string[], n: number, seed: number) => {
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    return Array.from({ length: n }, () => {
      let s = '';
      for (let i = 1 + Math.floor(rand() * 16); i > 0; i--) s += pool[Math.floor(rand() * pool.length)];
      return s;
    });
  };

  it('leaves every Latin-script key exactly as name-norm/1 produced it (L1: widened code-point pool)', () => {
    for (const s of generate(LATIN_POOL, 8000, 7)) expect(basicNormalize(s), JSON.stringify(s)).toBe(v1(s));
    for (const name of ['Société Générale', 'Søren Ltd', 'Straße GmbH', 'O’Reilly & Co', 'mt-nu(́P', 'ŉ Ltd'])
      expect(basicNormalize(name)).toBe(v1(name));
    expect(basicNormalizeV1('Café 東京 Ltd')).toBe(v1('Café 東京 Ltd'));
  });

  it('mixed-script names: removing the non-Latin letters (and their marks) from the v2 key gives the v1 key', () => {
    const pool = [...LATIN_POOL, ...'ромашкаЖΩμ東京トヨタがشركة', '゙'];
    const withoutOther = (v: string) =>
      v
        .replace(/(?:(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])[\p{L}\p{N}])\p{M}*/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    for (const s of generate(pool, 8000, 11))
      expect(withoutOther(basicNormalize(s)), JSON.stringify(s)).toBe(v1(s));
  });

  it('known v1 → v2 differences (documented in the market-sources contract)', () => {
    // Non-Latin letters are kept (the point of name-norm/2).
    expect([v1('ООО Ромашка'), basicNormalize('ООО Ромашка')]).toEqual(['', 'ооо ромашка']);
    expect([v1('Café 東京 Ltd'), basicNormalize('Café 東京 Ltd')]).toEqual(['cafe ltd', 'cafe 東京 ltd']);
    // A compatibility character that NFKC maps to a non-Latin letter becomes that letter.
    expect([v1('µ Labs'), basicNormalize('µ Labs')]).toEqual(['labs', 'μ labs']);
    expect([v1('Ω Ltd'), basicNormalize('Ω Ltd')]).toEqual(['ltd', 'ω ltd']);
  });

  it('lookups try the v2 key and the v1 key when it differs', () => {
    expect(strictNameKeysForLookup('Acme Ltd')).toEqual(['acme ltd']);
    expect(strictNameKeysForLookup('Café 東京 Ltd')).toEqual(['cafe 東京 ltd', 'cafe ltd']);
    expect(strictNameKeysForLookup('ООО Ромашка')).toEqual(['ооо ромашка']);
    expect(looseNameKeysForLookup('Café 東京 Ltd')).toEqual(['cafe 東京', 'cafe']);
    expect(strictNameKeyV1('Café 東京 Ltd')).toBe('cafe ltd');
  });
});
