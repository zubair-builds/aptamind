import { domainToUnicode } from 'node:url';
import { parse } from 'tldts';
import { companyDomain, looseNameKey, strictNameKey } from '../../companies/normalize';
import {
  addressGrammarVerdict,
  chargeRow,
  currentRow,
  domainShapedVerdict,
  rowBudgetLeft,
  RowBudgetExhausted,
  tokenizeForRow,
} from './contact-grammar';

/**
 * Value policy for company directory rows (DECISION_LOG "Company directory import hardening" and
 * "Company directory identity is structural"): a domain refusal list (defence in depth — identity
 * is structural: only the Domain column is domain identity, and a domain or id hit needs the
 * row's own name), contact-value detection for every cell the importer keeps, and placeholder
 * values that count as absent.
 */

/** Personal email providers (exact registrable domains). */
export const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'msn.com',
  'me.com',
  'mac.com',
  'proton.me',
  'pm.me',
  'web.de',
  'mail.com',
  'email.com',
  'mail.ru',
  'inbox.ru',
  'list.ru',
  'bk.ru',
  'rambler.ru',
  'qq.com',
  '163.com',
  '126.com',
  'sina.com',
  'naver.com',
  'daum.net',
  'btinternet.com',
  'btopenworld.com',
  'sky.com',
  'talktalk.net',
  'virginmedia.com',
  'ntlworld.com',
  'blueyonder.co.uk',
  'tiscali.co.uk',
  'ymail.com',
  'rocketmail.com',
  'fastmail.com',
  'fastmail.fm',
  'hushmail.com',
  'tutanota.com',
  'tuta.io',
  'zoho.com',
  'zohomail.com',
  't-online.de',
  'freenet.de',
  'arcor.de',
  'orange.fr',
  'wanadoo.fr',
  'free.fr',
  'sfr.fr',
  'laposte.net',
  'libero.it',
  'virgilio.it',
  'tiscali.it',
  'alice.it',
  'telenet.be',
  'skynet.be',
  'bluewin.ch',
  'seznam.cz',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  'onet.pl',
  'terra.com.br',
  'bol.com.br',
  'uol.com.br',
  'rediffmail.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'bellsouth.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'optonline.net',
  'shaw.ca',
  'rogers.com',
  'sympatico.ca',
  'bigpond.com',
  'bigpond.net.au',
  'optusnet.com.au',
  'xtra.co.nz',
]);

/**
 * Personal email brands matched by label on ANY public suffix (hotmail.co.uk, yahoo.fr,
 * outlook.de, gmx.at, icloud.com, …): the registrable domain without its suffix.
 */
export const PERSONAL_EMAIL_LABELS = new Set([
  'gmail',
  'googlemail',
  'hotmail',
  'outlook',
  'live',
  'windowslive',
  'yahoo',
  'ymail',
  'gmx',
  'aol',
  'icloud',
  'protonmail',
  'yandex',
]);

/**
 * Shared hosting, link-in-bio and site-builder hosts: a page there is not the company's own
 * domain. Matched on the host (the host itself or any subdomain of it).
 */
export const SHARED_HOSTING_HOSTS = [
  'sites.google.com',
  'docs.google.com',
  'drive.google.com',
  'forms.gle',
  'g.page',
  'goo.gl',
  'business.site',
  'wixsite.com',
  'editorx.io',
  'wordpress.com',
  'blogspot.com',
  'blogger.com',
  'github.io',
  'gitlab.io',
  'squarespace.com',
  'weebly.com',
  'webflow.io',
  'carrd.co',
  'godaddysites.com',
  'jimdosite.com',
  'jimdo.com',
  'strikingly.com',
  'site123.me',
  'tumblr.com',
  'medium.com',
  'substack.com',
  'notion.site',
  'notion.so',
  'netlify.app',
  'vercel.app',
  'herokuapp.com',
  'pages.dev',
  'firebaseapp.com',
  'web.app',
  'square.site',
  'myshopify.com',
  'linktr.ee',
  'linkin.bio',
  'beacons.ai',
  'bio.link',
  'about.me',
  'facebook.com',
  'fb.com',
  'instagram.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'youtube.com',
  'pinterest.com',
  'yell.com',
  'yelp.com',
  'checkatrade.com',
  'google.com/maps',
  // Map, search, cache, translation, archive and link-shortener hosts (DECISION_LOG 64d97b4): a
  // real company on such a host gets its identity from another source. (Google's map, search,
  // translate, business, `/url` and `/amp` pages on every Google domain: see `directoryDomain`.)
  'maps.apple.com',
  'mapquest.com',
  'map.baidu.com',
  'maps.here.com',
  'waze.com',
  '2gis.ru',
  'startpage.com',
  'ecosia.org',
  'search.brave.com',
  'ask.com',
  'bing.com',
  'duckduckgo.com',
  'openstreetmap.org',
  'archive.org',
  'archive.ph',
  'archive.today',
  'googleusercontent.com',
  'translate.goog',
  'ampproject.org',
  'share.google',
  'g.co',
  // URL shorteners, registers and company-information sites (never the company's own domain)
  'bit.ly',
  'tinyurl.com',
  't.co',
  'ow.ly',
  'buff.ly',
  'rebrand.ly',
  'is.gd',
  'cutt.ly',
  'shorturl.at',
  'gov.uk',
  'service.gov.uk',
  'opencorporates.com',
  'endole.co.uk',
  'companycheck.co.uk',
  // More link hosts that are never a company's own domain (re-verification #4 L4)
  'lnkd.in',
  'youtu.be',
  'trustpilot.com',
  'apply.workable.com',
];

/**
 * Contact-link hosts: a URL there opens a chat with a person (wa.me/447700900123, t.me/jane).
 * Refused as a contact value in every URL or domain cell.
 */
export const CONTACT_LINK_HOSTS = [
  'wa.me',
  'api.whatsapp.com',
  'chat.whatsapp.com',
  't.me',
  'telegram.me',
  'm.me',
  'signal.me',
  'viber.me',
  // re-verification #5
  'wa.link',
  'whatsapp.com', // web., api., chat. and the bare host
  'telegram.dog',
  // personal booking and meeting links
  'calendly.com',
  'cal.com',
  'zoom.us',
  'meet.google.com',
  'teams.microsoft.com',
  'teams.live.com',
];

/** Path segments that name a person's page (`/team/jane-smith`, `/people/…`, a vCard). */
const PERSON_PATH_SEGMENTS = new Set([
  'team',
  'our-team',
  'meet-the-team',
  'people',
  'staff',
  'person',
  'profile',
  'profiles',
  'author',
  'authors',
  'member',
  'members',
  'employee',
  'employees',
  'bio',
  'bios',
  'vcard',
  'contact-person',
]);

function onHost(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Reserved, documentation and junk domains. */
const RESERVED_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test.com']);
const RESERVED_TLDS = new Set([
  'test',
  'invalid',
  'local',
  'localhost',
  'example',
  'internal',
  'lan',
  'home',
  'corp',
]);

export type RefusedDomainReason =
  'personal_email' | 'shared_hosting' | 'reserved' | 'platform' | 'not_a_domain';

/** The lower-case host of a domain or URL cell, or null when it has none. */
export function hostOf(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(v) ? v : `http://${v}`).hostname.replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * The company domain of a Domain / Website / Careers URL cell, or why it is refused. This is the
 * ONE refusal function for every domain a directory row can contribute.
 */
export function directoryDomain(value: string): { domain: string } | { refused: RefusedDomainReason } {
  const host = hostOf(value);
  if (!host) return { refused: 'not_a_domain' };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') || !host.includes('.'))
    return { refused: host === 'localhost' ? 'reserved' : 'not_a_domain' };
  const tld = host.slice(host.lastIndexOf('.') + 1);
  const pub = parse(host, { allowPrivateDomains: false });
  if (RESERVED_TLDS.has(tld) || (pub.domain && RESERVED_DOMAINS.has(pub.domain)))
    return { refused: 'reserved' };
  // An ICANN-registrable domain only (re-verification #12): `jane.smith`, `acme.notatld` or
  // `r.wjb3n` — an email's local part among them — never becomes identity.
  if (!pub.isIcann || !pub.domain || !pub.domainWithoutSuffix) return { refused: 'not_a_domain' };
  if (
    (pub.domain && PERSONAL_EMAIL_DOMAINS.has(pub.domain)) ||
    (pub.domainWithoutSuffix && PERSONAL_EMAIL_LABELS.has(pub.domainWithoutSuffix))
  )
    return { refused: 'personal_email' };
  // The path, decoded and `//`-collapsed (DECISION_LOG d232db7): as parsed, and from the fully
  // decoded cell (`%6Daps`, `%2Furl`, and `&#x6d;aps`, whose `#` would otherwise start a fragment).
  const pathOf = (text: string) => {
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).pathname;
    } catch {
      return '/';
    }
  };
  const paths = [
    ...new Set(
      [pathOf(value.trim()), pathOf(decodeEscapes(value.trim()))].map((p) => normalizedPath(p).toLowerCase()),
    ),
  ];
  // Google's map, search, translate, business, images, lens, news, scholar, books and shopping
  // hosts, and its `/maps`, `/search`, `/url`, `/amp`, `/translate` pages, on any Google domain
  // (maps.google.co.uk, google.de/maps, translate.google.com, google.com/url?q=…).
  if (
    pub.domainWithoutSuffix === 'google' &&
    (/^(?:[a-z0-9-]+\.)*(?:maps|translate|business|images|lens|news|scholar|books|shopping)\./.test(host) ||
      paths.some((path) => /^\/(?:maps|search|url|amp|translate)(?:[/?#]|$)/.test(path)))
  )
    return { refused: 'shared_hosting' };
  for (const shared of SHARED_HOSTING_HOSTS) {
    const [sharedHost, sharedPath] = shared.split(/(?=\/)/) as [string, string | undefined];
    const hostMatches = host === sharedHost || host.endsWith(`.${sharedHost}`);
    if (hostMatches && (!sharedPath || paths.some((path) => path.startsWith(sharedPath))))
      return { refused: 'shared_hosting' };
  }
  const domain = companyDomain(host);
  return domain ? { domain } : { refused: 'platform' };
}

/** The outcome of reducing a URL cell (DECISION_LOG 29b6592): dropped, invalid, or the URL to store. */
export type ReducedUrl =
  | { kind: 'contact' }
  | { kind: 'invalid' }
  | { kind: 'url'; url: string; origin: string; host: string; reduced: boolean };

/** A path kept as written: only these characters (no `%`, `&`, `;`, `?`, `#`, backslash). */
const PLAIN_PATH = /^[A-Za-z0-9._~/-]*$/;

/**
 * Reduce a URL cell (Domain, Website, Careers URL) instead of parsing it (DECISION_LOG 29b6592):
 * scheme, host, path, query and fragment are split on the text AS WRITTEN (backslashes read as
 * `/`). The host keeps the fail-closed rules — any `@`-like character or at-form (`at`, `arroba`,
 * `(a)`) before its public suffix makes the cell a contact value; an at-form that is only the
 * suffix (the ccTLD `.at`) does so only before a plain, domain-shaped path
 * (`https://jane.at/gmail.com`). The path is kept only if it is plain as written and holds no
 * at-form or dot-form token; otherwise only the origin (`scheme://host/`) is stored (`reduced`).
 * Query and fragment are never stored.
 */
export function reduceUrlCell(value: string, opts: { domainCell?: boolean } = {}): ReducedUrl {
  const written = value.trim().replace(/\\/g, '/');
  // A contact URI (`tel:`, `mailto:`, …) is a contact value whatever follows.
  if (/^(?:mailto|tel|sms|callto|whatsapp|skype):/i.test(contactText(written))) return { kind: 'contact' };
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]*)([^?#]*)/i.exec(written);
  if (!m) return { kind: 'invalid' };
  const scheme = (m[1] ?? 'https').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return { kind: 'invalid' };
  // The authority, decoded: credentials or any `@`-like character are a contact value.
  const authority = decodeEscapes(m[2]!);
  if (AT_LIKE.test(authority) || AT_LIKE.test(authority.normalize('NFKC'))) return { kind: 'contact' };
  const hostPort = /^(.*?)(?::(\d*))?$/.exec(authority)!;
  const host = hostPort[1]!.toLowerCase().replace(/\.+$/, '');
  const port = hostPort[2];
  if (!host) return { kind: 'invalid' };
  const suffix = parse(host, { allowPrivateDomains: false }).publicSuffix;
  const onSuffix = !!suffix && host.endsWith(`.${suffix}`);
  const beforeSuffix = onSuffix ? host.slice(0, -suffix!.length - 1) : host;
  // (A Domain cell keeps the documented residual `at-home.co.uk`; its stored value is still checked
  // below, so `jobs-at-acme.com`, an address when read, is dropped.)
  if (!opts.domainCell && hasToken(beforeSuffix, 'at')) return { kind: 'contact' };
  const path = m[3]!;
  const plainChars = PLAIN_PATH.test(path);
  if (
    onSuffix &&
    hasToken(suffix!, 'at') &&
    plainChars &&
    domainShapedVerdict(contactText(path, 'space')) !== 'none'
  )
    return { kind: 'contact' };
  let origin: URL;
  try {
    const defaultPort = scheme === 'https' ? '443' : '80';
    origin = new URL(`${scheme}://${host}${port && port !== defaultPort ? `:${port}` : ''}/`);
  } catch {
    return { kind: 'invalid' };
  }
  // The serialisation must store what was written (DECISION_LOG bd6ad44): a host that IDNA maps
  // to something else (`a™t` → `atmt`, `ａｃｍｅ` → `acme`, deleted or reordered code points) is
  // not the host the cell spelled — the cell is dropped. The stored host equals the written one
  // in its punycode or its Unicode form (`bücher.de`, `xn--bcher-kva.de`).
  if (origin.hostname !== host && domainToUnicode(origin.hostname) !== host.normalize('NFC'))
    return { kind: 'invalid' };
  const originText = `${origin.protocol}//${origin.host}/`;
  // A platform word in the path, query or fragment reduces the URL to its origin (DECISION_LOG
  // ed7b71a (2): `/skype/jane_doe`, `/careers/whatsapp/91234567`, `?skype=jane.doe`).
  const rest = written.slice(m[0].length);
  const platformInPath = [path + rest, decodeEscapes(path + rest)].some(hasPlatformWordToken);
  const keepPath = plainChars && !hasToken(path, 'at') && !hasToken(path, 'dot') && !platformInPath;
  const hasPath = /[^/]/.test(path) || platformInPath;
  const url =
    keepPath && hasPath
      ? `${originText.slice(0, -1)}${path.startsWith('/') ? path : `/${path}`}`
      : originText;
  // Check what is stored (DECISION_LOG bd6ad44): the serialised URL, and its host as a reader may
  // see it, through the full detector — IDNA deletes default-ignorables and punycode moves ASCII to
  // the front, so the stored host can spell what the written one did not
  // (`jane-a¡t-gmail-dot-com.acme.com` → `xn--jane-at-gmail-dot-com-6ua.acme.com`).
  // (A Domain cell stores only its domain, which the caller checks the same way.)
  if (!opts.domainCell && storedValueHasContact(url, origin.hostname)) return { kind: 'contact' };
  return { kind: 'url', url, origin: originText, host: origin.hostname, reduced: hasPath && !keepPath };
}

/**
 * The forms of a stored host a reader may see (DECISION_LOG bd6ad44): as serialised (punycode) and
 * in Unicode (`domainToUnicode`: `xn--janeatgmail-…` reads `jane¡at¡gmail`). (A punycode label's
 * ASCII part needs no form of its own: the label tokenisation already splits a hyphen-delimited
 * `at` out of `xn--jane-at-gmail-6ua`.)
 */
export function storedHostForms(host: string): string[] {
  return [...new Set([host, domainToUnicode(host) || host])];
}

/**
 * Whether a value about to be stored holds a contact value (DECISION_LOG bd6ad44: check what you
 * store): the full detector, at-words on, on the exact stored string and — for a URL or domain —
 * on every form of its host. An undecidable search fails closed.
 */
export function storedValueHasContact(stored: string, host?: string): boolean {
  const forms = [stored, ...(host ? storedHostForms(host) : [])];
  return forms.some((f) => contactValueVerdict(f) !== 'none');
}

/**
 * Invisible code points (DECISION_LOG bd6ad44): default-ignorables (zero-width characters, soft
 * hyphen, variation selectors, CGJ, Mongolian selectors, tags), format and bidi controls, other
 * controls, line and paragraph separators, and blank fillers. No company URL needs one.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Zl}\p{Zp}\u2800]/u;

/** Whether a URL, Domain or Website cell holds an invisible code point, as written or decoded. */
export function hasInvisibleCodePoint(value: string): boolean {
  return [value, decodeStable(value), decodeEscapes(value)].some(
    (v) => INVISIBLE.test(v) || INVISIBLE.test(v.normalize('NFKC')),
  );
}

/** Whether `text` holds a token of `kind` under either hyphen tokenisation. */
function hasToken(text: string, kind: 'at' | 'dot'): boolean {
  const v = contactText(text, 'space');
  try {
    return (['separator', 'label'] as const).some((mode) =>
      tokenizeForRow(v, mode).some((t) => t.kind === kind),
    );
  } catch (err) {
    // The row's work budget is spent (DECISION_LOG 47c0f5c): assume the token (fails closed).
    if (err instanceof RowBudgetExhausted) return true;
    throw err;
  }
}

/** Whether a host is on an ICANN-registrable domain (`careers.acme.co.uk`; not `jane`, `jane.smith`). */
export function isRegistrableHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const pub = parse(h, { allowPrivateDomains: false });
  return !!pub.isIcann && !!pub.domain && !!pub.domainWithoutSuffix && !pub.isIp;
}

/** Whether a host passes the directory refusal list (see `directoryDomain`). */
export function isAcceptedDirectoryDomain(domainOrUrl: string | null | undefined): boolean {
  return !!domainOrUrl && 'domain' in directoryDomain(domainOrUrl);
}

const CONTACT_SCHEME = /(?:^|[^a-z])(?:mailto|tel|sms|callto|whatsapp|skype):/i;
/**
 * Phone-number candidates: a run of digits and separators that starts with `+`, `00` or a
 * national `0` (optionally in brackets).
 */
const PHONE_RUN = /(?:^|[^\p{L}\p{N}+])((?:\+|\(?0)[\d\s().\-/]{7,}\d)(?![\p{L}\p{N}])/gu;

/**
 * Whether a text holds a phone number: 9–15 digits, written as `+44 …` / `0044 …`
 * (international), or as a national number starting with 0 and written with separators
 * (`020 7946 0958`, `(020) 7946-0958`, `07700 900123`), or a UK mobile without separators
 * (`07700900123`). A digits-only run without a leading `+`/`0` (an id, `/jobs/1234567`) is not.
 */
function hasPhoneNumber(value: string): boolean {
  for (const m of value.matchAll(PHONE_RUN)) {
    const run = m[1]!.trim();
    const digits = run.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) continue;
    if (run.startsWith('+')) return true;
    if (digits.startsWith('00')) {
      if (digits[2] !== '0') return true;
      continue;
    }
    if (/[\s().\-/]/.test(run) || /^07\d{9}$/.test(digits)) return true;
  }
  return false;
}

/** Runs of digits, separators optional (`123456789`, `0 7700 900 123`). */
const DIGIT_RUN = /\d(?:[\s().\-/]{0,2}\d)*/g;

/**
 * Phone-like digit runs in a name, legal name or town cell: any run of 9–15 digits (separators
 * optional) — the ruled bar (DECISION_LOG 621f14c; a 7- or 8-digit run is not refused: `9123-4567
 * Québec inc.` is a name) — and, in a town (`minRun: 6`), any run of 6 or more digits.
 */
function hasLongDigitRun(value: string, minRun?: number): boolean {
  for (const m of value.matchAll(DIGIT_RUN)) {
    const n = m[0].replace(/\D/g, '').length;
    if (n > 15) continue;
    if (n >= 9) return true;
    if (minRun !== undefined && n >= minRun) return true;
  }
  return false;
}

/** A person's profile link written into a text cell (`linkedin.com/in/jane`, `github.com/jane`). */
const PROFILE_LINK_IN_TEXT =
  /(?:^|[^\p{L}\p{N}.-])(?:[a-z]{2,3}\.)?(?:linkedin\.com\/(?:in|pub)|facebook\.com|fb\.com|instagram\.com|twitter\.com|x\.com|github\.com|tiktok\.com|about\.me|linktr\.ee)\/[\p{L}\p{N}._-]+/iu;

/** A contact link written into a text cell (`t.me/jane`, `wa.me/447700900123`, `t.me jane`). */
const CONTACT_LINK_IN_TEXT = new RegExp(
  `(?:^|[^\\p{L}\\p{N}.-])(?:${['wa.me', 'wa.link', 't.me', 'telegram.me', 'telegram.dog', 'm.me', 'signal.me', 'viber.me', 'calendly.com', 'zoom.us'].map((h) => h.replace('.', '\\.')).join('|')})(?:\\/|\\s+[\\p{L}\\p{N}@_]+)`,
  'iu',
);

/** `@`-like characters (NFKC maps the full-width and small forms to `@`; kept for safety). */
const AT_LIKE = /[@\uff20\ufe6b]/;

/**
 * The text contact detection reads, character-level only (DECISION_LOG af1b342: the notations are
 * matched by the grammar, never folded): NFKC (full-width `＠` → `@`, full-width and mathematical
 * digits → ASCII) and ideographic and full-width full stops (`。．｡`) folded to `.`; zero-width
 * characters (ZWSP, ZWNJ, ZWJ, word joiner, BOM, soft hyphen) removed, or — `zeroWidth: 'space'` —
 * turned into spaces, as the name keys do.
 */
export function contactText(value: string, zeroWidth: 'remove' | 'space' = 'remove'): string {
  return (
    value
      .normalize('NFKC')
      // Every default-ignorable code point (zero-width characters, soft hyphen, bidi marks,
      // variation selectors, invisible operators, CGJ, …): removed, or turned into a space.
      .replace(/\p{Default_Ignorable_Code_Point}/gu, zeroWidth === 'space' ? ' ' : '')
      // An orphan combining mark (after no letter or digit) is a separator.
      .replace(/(^|[^\p{L}\p{N}\p{M}])\p{M}+/gu, '$1 ')
      .replace(/[\u3002\uff0e\uff61]/g, '.')
  );
}

/** Invisible and format code points (the canonical form turns each into a space). */
const INVISIBLE_TEXT = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Zl}\p{Zp}\u2800]/gu;

/** A lone surrogate code unit (a high surrogate not followed by a low one, or a low one alone). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The text made well-formed (`String.prototype.toWellFormed`): every lone surrogate becomes
 * U+FFFD, exactly as BSON stores it (DECISION_LOG d232db7), so what is checked is what is stored.
 */
export function wellFormed(value: string): string {
  return value.replace(LONE_SURROGATE, '\ufffd');
}

/** Rounds `canonicalText` may take before a cell is undecidable (DECISION_LOG d232db7). */
export const CANONICAL_MAX_ROUNDS = 64;

/**
 * The canonical form of a text cell (DECISION_LOG 64d97b4, d232db7): well-formed, HTML entities
 * and percent-escapes decoded, NFKC, every default-ignorable, invisible or format code point turned
 * into a space, whitespace collapsed — repeated until the value no longer changes (a true fixed
 * point: every change of a decode shrinks the text). A value that has not converged within
 * `CANONICAL_MAX_ROUNDS` rounds is undecidable (null): the cell fails closed. The canonical form is
 * what is checked, stored and keyed.
 */
export function canonicalText(value: string): string | null {
  let cur = wellFormed(value);
  for (let k = 0; k < CANONICAL_MAX_ROUNDS; k++) {
    const next = wellFormed(decodeEscapes(cur).normalize('NFKC').replace(INVISIBLE_TEXT, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (next === cur) return cur;
    cur = next;
  }
  return null;
}

/** Code points the ruled skeleton keeps: letters, digits, ASCII punctuation and space. */
const SKELETON_KEEP = /[\p{L}\p{N}\x20-\x7e]/u;
/** Code points the glued skeleton removes: non-ASCII symbols, private-use and unassigned. */
const SKELETON_GLUE = /[\p{S}\p{Co}\p{Cn}]/u;

/**
 * The skeletons the detector also reads (DECISION_LOG 64d97b4). Both start from NFD with every
 * mark removed (`àt`, `a\u{16FE4}t` → `at`). The ruled skeleton then turns every code point
 * outside letters, digits, ASCII punctuation and space into a space. The glued skeleton, failing
 * closed, instead removes non-ASCII symbols (`a\u{1D159}t` → `at`) and keeps all punctuation, so
 * bracketed and dotted forms survive (`»á«` → `»a«`, `jane·a\u{1D159}t·gmail·com`).
 */
function skeletons(value: string): string[] {
  const markless = value.normalize('NFD').replace(/\p{M}/gu, '');
  let spaced = '';
  let glued = '';
  for (const ch of markless) {
    spaced += SKELETON_KEEP.test(ch) ? ch : ' ';
    glued += ch.charCodeAt(0) < 0x80 || !SKELETON_GLUE.test(ch) ? ch : '';
  }
  return [spaced, glued.normalize('NFC')];
}

/** Whether a token is a registrable domain on an ICANN public suffix (`acme.com`, `acme.co.uk`). */
function isRegistrableDomain(token: string): boolean {
  const t = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
  if (!t.includes('.')) return false;
  const p = parse(t, { allowPrivateDomains: false });
  return !!p.domain && !!p.domainWithoutSuffix && p.isIcann === true && p.hostname === t;
}

/** Named HTML entities that spell punctuation used to hide an address. */
const HTML_ENTITIES: Record<string, string> = {
  commat: '@',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  period: '.',
  sol: '/',
  bsol: '\\',
  lpar: '(',
  rpar: ')',
  lsqb: '[',
  rsqb: ']',
  lbrack: '[',
  rbrack: ']',
  lbrace: '{',
  rbrace: '}',
  lcub: '{',
  rcub: '}',
  plus: '+',
  hyphen: '-',
  dash: '-',
  lowbar: '_',
  colon: ':',
  semi: ';',
  num: '#',
  excl: '!',
  percnt: '%',
  comma: ',',
  equals: '=',
  quest: '?',
  ast: '*',
  midast: '*',
  middot: '\u00b7',
  centerdot: '\u00b7',
  bull: '\u2022',
  thinsp: '\u2009',
  ensp: ' ',
  emsp: ' ',
  // Invisible characters decode to themselves (DECISION_LOG 64d97b4): the canonical form turns
  // them into a space, so `jane&shy;at` reads `jane at`, never the glued `janeat`.
  zwsp: '\u200b',
  zerowidthspace: '\u200b',
  zwj: '\u200d',
  zwnj: '\u200c',
  shy: '\u00ad',
  nobreak: '\u2060',
  lrm: '\u200e',
  rlm: '\u200f',
  applyfunction: '\u2061',
  invisibletimes: '\u2062',
  invisiblecomma: '\u2063',
};

/**
 * HTML entities (`&#64;`, `&#x40;`, `&commat;`, …) and percent-escapes decoded, repeatedly until
 * stable (at most 5 rounds), so `jane&#64;acme.com` and `jane%40acme.com` read as `jane@acme.com`.
 */
export function decodeEscapes(value: string): string {
  let cur = value;
  for (let k = 0; k < 5; k++) {
    const next = decodeStable(
      cur
        // Any number of leading zeros, as HTML5 accepts (`&#00000064;`, `&#x0000002e;`).
        .replace(/&#x0*([0-9a-f]{1,6});?/gi, (m, h: string) => safeCodePoint(parseInt(h, 16)) ?? m)
        .replace(/&#0*(\d{1,7});?/g, (m, d: string) => safeCodePoint(parseInt(d, 10)) ?? m)
        .replace(/&([a-z]+);/gi, (m, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? m),
    );
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function safeCodePoint(cp: number): string | null {
  // A surrogate code point is no character: U+FFFD, as a well-formed string stores it.
  if (cp >= 0xd800 && cp <= 0xdfff) return '\ufffd';
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
}

/**
 * An email address, structurally (DECISION_LOG b24e5dd, af1b342): any `@`-like character; an
 * address of the standard-notation grammar (`matchesAddressGrammar`: local part, at-form, labels
 * joined by dot-forms, a public suffix — `atTokens: false` leaves only `@`-like at-forms, for URL
 * hosts); or `#` followed by a registrable domain (`jane#acme.com`).
 */
function hasEmailLike(v: string, atTokens: boolean, t: Tracker): boolean {
  if (AT_LIKE.test(v)) return true;
  if (/[\p{L}\p{N}._%+-]#[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u.test(v)) {
    const m = /#([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)/u.exec(v);
    if (m && isRegistrableDomain(m[1]!)) return true;
  }
  return grammar(v, { atWords: atTokens }, t);
}

/** Records a grammar search that could not decide (it fails closed: see `contactValueVerdict`). */
interface Tracker {
  undecided: boolean;
}

/** The grammar on `v`: true for an address; an undecided search is recorded and throws `Undecided`. */
function grammar(v: string, opts: { atWords?: boolean }, t: Tracker): boolean {
  const verdict = addressGrammarVerdict(v, opts);
  if (verdict === 'undecided') {
    t.undecided = true;
    throw UNDECIDED;
  }
  return verdict === 'match';
}
const UNDECIDED = new Error('contact value undecidable');

/**
 * Digit runs, structurally: consecutive decimal digits of any script (`\p{Nd}`) separated only by
 * characters that are not letters (spaces of every kind, every dash, `_`, `·`, `•`, `,`, `.`,
 * brackets, …). In a token of digits mixed only with `o`/`O`/`l`/`I` (`o77oo9oo123`), those
 * letters count as digits.
 */
function longestDigitRun(value: string): number {
  const v = value.replace(/[\p{L}\p{N}]+/gu, (tok) =>
    /^[\p{Nd}oOlI]+$/u.test(tok) && (tok.match(/\p{Nd}/gu) ?? []).length >= 5
      ? tok.replace(/[oO]/g, '0').replace(/[lI]/g, '1')
      : tok,
  );
  // The digits of each stretch without a letter (a letter ends a run; anything else continues it):
  // one linear pass of two regex scans (DECISION_LOG 47c0f5c), not a regex test per character.
  let best = 0;
  for (const stretch of v.split(/\p{L}+/u)) best = Math.max(best, stretch.match(/\p{Nd}/gu)?.length ?? 0);
  return best;
}

/** A messaging-platform word, as a whole word (`skype`, `skype=`, `skype(`, `skype.jane`). */
const PLATFORM_WORDS =
  'skype|whatsapp|telegram|signal|wechat|viber|discord|slack|snapchat|insta|instagram|kik|threema|kakao|kakaotalk|twitter';
const HANDLE_PLATFORM = new RegExp(`(?<![\\p{L}\\p{N}])(?:${PLATFORM_WORDS})(?![\\p{L}\\p{N}])`, 'iu');
const PLATFORM_WORD = new RegExp(`^(?:${PLATFORM_WORDS})$`, 'i');
/**
 * Whether a URL's path, query or fragment holds a platform word as a token (split on anything not
 * a letter or digit; DECISION_LOG ed7b71a (2): `/skype/jane_doe`, `/careers/whatsapp/91234567`).
 */
export function hasPlatformWordToken(text: string): boolean {
  return text.split(/[^\p{L}\p{N}]+/u).some((t) => PLATFORM_WORD.test(t));
}
/** The characters that join a handle's parts and read as `.` (DECISION_LOG d232db7, 47c0f5c). */
const HANDLE_DOTS = '٫۔·•‧・･∙⋅⸱᛫ꞏ⸳';
/**
 * A token of a text cell: letters and digits joined by `.`, `_`, `#` or a dot-like character
 * (`jane.doe`, `jane_doe`, `jane#1234`, `jane·doe`, `jane・doe`), or `+` and digits. Every other
 * character — `-`, `/`, `|`, `=`, `:`, brackets, spaces — separates tokens (DECISION_LOG d232db7).
 */
const HANDLE_WORD = '[\\p{L}\\p{N}]+(?:-[\\p{L}\\p{N}]+)*';
const HANDLE_TOKEN = new RegExp(`\\+\\d+|${HANDLE_WORD}(?:[._#${HANDLE_DOTS}]+${HANDLE_WORD})*`, 'gu');
const HANDLE_DOT_CHARS = new RegExp(`[${HANDLE_DOTS}]`, 'gu');
/**
 * Legal forms (DECISION_LOG 47c0f5c: one list, documented in the contract). A dotted token whose
 * every part is a capitalised legal form or abbreviation is a company name (`Signal Co.Ltd`,
 * `Signal Tic.Ltd.Şti.`, `Slack GmbH & Co.KG`).
 */
const HANDLE_LEGAL_FORMS = new Set(
  (
    'ltd limited inc incorporated llc llp lllp pllc plc corp corporation co company sa sas sarl bv bvba nv gmbh ag kgaa ' +
    'srl sl slu spa pty lp oy oyj ab as asa aps kg se ev kk sro doo pc pa ooo oao zao pao ao ug kft zrt sp zoo spzoo ' +
    'oü uab sia bhd sdn pte pvt ltda şti me eirl sab cv rl wll fze fzco fzllc hf ehf'
  ).split(' '),
);
/**
 * Abbreviations that are parts of company names (DECISION_LOG 47c0f5c): capitalised in the token
 * (`Signal Hill Tech.Ltd`, `Mfg.Co.`, `Bros.Inc.`, `Hldgs.Ltd.`, `Mgmt.Co.`, `Tech.Co.`, `Ass.Ltd`).
 * Titles (`Mr`, `Mrs`, `Ms`, `Dr`, `Prof`, `Sir`, `Rev`) are never abbreviations here.
 */
const HANDLE_ABBREVIATIONS = new Set(
  (
    'tech mfg mfgs mfr mfrs bros hldg hldgs holdg dept div int intl natl grp ass assoc assn mgmt mgt svc svcs serv ' +
    'ind inds indus eng engg gen univ inst fdn ctr dev mkt mktg prod prods dist distr trad tic san ent ents inv invest ' +
    'cap fin ins mut coop lux wash calif mass penn ft jr sr est sp ges cía soc com reg no nr'
  ).split(' '),
);
/** Abbreviations written in lower case in company names (`est.2011`, `AB publ`, `dba`). */
const HANDLE_LOWER_ABBREVIATIONS = new Set(['est', 'publ', 'dba', 'fka', 'nka', 'e']);
/** A prefix that, with one capitalised word, is a place or unit (`St.Petersburg`, `Ft.Worth`, `Dept.Sales`). */
const HANDLE_NAME_PREFIX = /^(?:st|mt|ft|dept|div)$/i;
/** A part compared with the lists in its skeleton form (the skeleton reading turns `Şti` into `Sti`). */
const plainPart = (p: string) => p.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const HANDLE_LEGAL_PLAIN = new Set([...HANDLE_LEGAL_FORMS].map(plainPart));
const HANDLE_ABBREVIATIONS_PLAIN = new Set([...HANDLE_ABBREVIATIONS].map(plainPart));

/** Registry markers: digits after one are a registration number, not a phone (`No. 12345678`). */
const REGISTRY_MARKER = /^(?:no|nr|reg|regno|n°|nº|vat)$/i;

/**
 * Whether a domain token is a self-reference (DECISION_LOG ed7b71a (1)): exactly a registrable
 * domain (or `www.` and one), whose registrable label — hyphens removed, case ignored — is the
 * concatenation of one or more consecutive **other** words of the cell (`Slack Ltd t/a Slack.com`,
 * `Signal AI Ltd (signal-ai.com)`, `Signal Hill Ltd (SignalHill.COM)`), or is a platform's own
 * name (`Signal.co.uk Ltd`). `skype jane.com`, `skype min.kim` are not: a surname can be a TLD.
 */
function isSelfReferencedDomain(
  token: string,
  words: readonly { word: string; token: number }[],
  own: number,
): boolean {
  chargeRow(20); // a domain parse (DECISION_LOG ed7b71a (5))
  const t = token.toLowerCase();
  const p = parse(t, { allowPrivateDomains: false });
  if (!p.domain || !p.isIcann || !p.domainWithoutSuffix || (t !== p.domain && t !== `www.${p.domain}`))
    return false;
  const label = p.domainWithoutSuffix.replace(/-/g, '');
  if (PLATFORM_WORD.test(label)) return true;
  // Consecutive words of the other tokens (the domain token's own words are skipped), joined up
  // to the label's length: linear in the words for a label of at most 63 characters.
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.token === own || !label.startsWith(words[i]!.word)) continue;
    let joined = '';
    for (let j = i; j < words.length && joined.length < label.length; j++) {
      if (words[j]!.token === own) continue;
      joined += words[j]!.word;
      if (joined === label) return true;
    }
  }
  return false;
}

/**
 * A messaging handle written out, in a **text** cell only (DECISION_LOG 47c0f5c, amended by
 * ed7b71a: name, legal name, trading-as, town, id — never a URL or Domain cell): when a platform
 * word appears anywhere in the cell, **every** token before and after it is examined (`Acme
 * jane.doe on skype`, `jane.doe (skype)`, `skype - jane.doe`, `skype=TOM.LEE`, `skype jane·doe`,
 * `discord jane#1234`). A handle is a token that is `+` and digits, letters with 5 or more digits
 * or handle-shaped; an `<alnum>:<alnum>` pair next to a platform word (`skype live:janedoe`); or a
 * run of 7 or more digits (joined by spaces, hyphens or dots) next to a platform word
 * (`whatsapp 91234567`, `viber 555 1234`) unless a registry marker (`No.`, `Nr.`, `Reg.`, `#`)
 * precedes it. Digits alone elsewhere (`Omaha NE 68102`, `Company No. 12345678`) and a
 * self-referenced domain not next to the platform word are not handles.
 */
function hasHandle(v: string): boolean {
  if (!HANDLE_PLATFORM.test(v)) return false;
  const tokens = [...v.matchAll(HANDLE_TOKEN)].map((m) => ({
    text: m[0].replace(HANDLE_DOT_CHARS, '.'),
    start: m.index,
    end: m.index + m[0].length,
  }));
  const isPlatform = (k: number) => k >= 0 && k < tokens.length && PLATFORM_WORD.test(tokens[k]!.text);
  const gap = (k: number) => v.slice(tokens[k]!.end, tokens[k + 1]?.start ?? v.length);
  // The walk is charged to the row's budget, one unit per token (DECISION_LOG ed7b71a (5)).
  chargeRow(tokens.length);
  const words = tokens.flatMap((t, token) =>
    t.text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .map((word) => ({ word, token })),
  );
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!.text;
    if (isPlatform(k)) continue;
    // A run of digit tokens joined by single spaces, hyphens or dots (`555 1234`, `07700-900-123`).
    if (/^[\d.-]+$/.test(token) && /\d/.test(token)) {
      let last = k;
      while (
        last + 1 < tokens.length &&
        /^[\d.-]+$/.test(tokens[last + 1]!.text) &&
        /^[ .-]$/.test(gap(last))
      )
        last++;
      const digits = tokens.slice(k, last + 1).reduce((n, t) => n + (t.text.match(/\d/g)?.length ?? 0), 0);
      const marked =
        (k > 0 && REGISTRY_MARKER.test(tokens[k - 1]!.text)) || (k > 0 && gap(k - 1).includes('#'));
      if (digits >= 7 && !marked && (isPlatform(k - 1) || isPlatform(last + 1))) return true;
      k = last;
      continue;
    }
    if (/^\+\d/.test(token)) return true;
    // A registration or VAT number after a registry marker (`VAT No. GB123456789`).
    if (k > 0 && REGISTRY_MARKER.test(tokens[k - 1]!.text)) continue;
    // `live:janedoe` — an alnum:alnum pair next to a platform word.
    if (gap(k) === ':' && k + 1 < tokens.length && (isPlatform(k - 1) || isPlatform(k + 2))) return true;
    // Letters with 5 or more digits in one part (`jane12345`, `jane.doe85123`); digits alone in a
    // dotted token are a number (`Reg.No.01234567`).
    if (token.split(/[._#]+/).some((part) => /\p{L}/u.test(part) && /\d{5,}/.test(part))) return true;
    // A self-referenced domain, not next to the platform word, is the company's own website.
    if (/\./.test(token) && !isPlatform(k - 1) && !isPlatform(k + 1)) {
      if (isSelfReferencedDomain(token, words, k)) continue;
    }
    if (isHandleShaped(token)) return true;
  }
  return false;
}

/**
 * A handle-shaped token: parts joined by `.`, `_` or `#` (`jane.smith`, `v.petrov`, `jane_smith`,
 * `jane#1234`). Exempt only (DECISION_LOG 29b6592 (3), 64d97b4, d232db7, 47c0f5c): single letters
 * around dots (`e.V`, `U.S.A`, `s.r.o`), version numbers (`3.0`, `3.14`, `v2.0`), a registrable
 * domain (`Slack.com`), every part a capitalised legal form or abbreviation, a single capital or
 * digits (`Co.Ltd`, `Tech.Co`, `P.Ltd`, `Tic.Ltd.Şti`) or a lower-case abbreviation (`est.2011`),
 * and — the **whole** token — `No` / `Nr` and digits (`No.1`) or `St` / `Mt` / `Ft` / `Dept` /
 * `Div` and one capitalised word (`St.Petersburg`, `Dept.Sales`), never as a prefix
 * (`St.Jane.Doe`, `No.1.jane`); never a title, an initial before a surname, a lower-case legal
 * form or a capitalised handle (`dr.smith`, `Mr.Brown`, `v.petrov`, `co.ltd`, `TOM.LEE`, `E.ON`).
 */
function isHandleShaped(token: string): boolean {
  if (!/[\p{L}\p{N}][._#]+[\p{L}\p{N}]/u.test(token)) return false;
  if (/[_#]/.test(token)) return true;
  // Polish and Austrian forms whose lower-case letters are part of the form (DECISION_LOG ed7b71a (6)).
  if (/^sp\.[zjk]$|ges\.m\.b\.h$/i.test(token)) return false;
  const parts = token.split(/\.+/).filter(Boolean);
  if (parts.every((p) => [...p].length === 1)) return false; // U.K., s.r.o., A.Ş.
  if (parts.every((p, i) => /^\d+$/.test(p) || (i === 0 && /^v\d+$/i.test(p)))) return false; // 3.0, v2.0
  const listed = (p: string) =>
    HANDLE_LEGAL_PLAIN.has(plainPart(p)) || HANDLE_ABBREVIATIONS_PLAIN.has(plainPart(p));
  const known = (p: string) =>
    /^\d+$/.test(p) ||
    HANDLE_LOWER_ABBREVIATIONS.has(p) ||
    (/^\p{Lu}/u.test(p) && ([...p].length === 1 || listed(p)));
  if (parts.every(known)) return false; // Co.Ltd, Tech.Co, Hldgs.Ltd, P.Ltd, est.2011
  // A lower-case single letter beside capitalised forms (`Kakao i.Corp`, `Ind.e Com.Ltda`); never
  // `z`, `j` or `k`, which only the `Sp.` forms accept (DECISION_LOG ed7b71a (6)).
  const letter = (p: string) => /^\p{Ll}$/u.test(p) && !/^[zjk]$/.test(p);
  if (
    parts.some((p) => !letter(p) && known(p) && !/^\d+$/.test(p)) &&
    parts.every((p) => letter(p) || known(p))
  )
    return false;
  // Legal forms and abbreviations that are not capitalised are a handle, even when they spell a
  // domain (`co.ltd`: `.ltd` is a TLD).
  if (parts.every((p) => /^\d+$/.test(p) || [...p].length === 1 || listed(p))) return true;
  if (parts.length === 2) {
    const [first, second] = parts as [string, string];
    if (/^n[or]$/i.test(first) && /^\d+$/.test(second)) return false; // No.1, Nr.5
    if (HANDLE_NAME_PREFIX.test(first) && /^\p{Lu}\p{Ll}*$/u.test(second)) return false; // St.Petersburg, Dept.Sales
  }
  return true;
}

/**
 * Whether a cell holds a contact value (DECISION_LOG re-verification #5, structural): an
 * email-like value (`hasEmailLike`), a contact URI, a messaging handle or contact link written in
 * the text (`t.me/jane`), a phone number, and — with `digitRuns` (name, legal name, town) — any
 * 9 or more digits separated only by non-letters (the ruled bar; no 7-digit rule). With
 * `town`, any run of 6 or more digits (a town may hold no digits at all: see `hasDigit`).
 */
export function hasContactValue(
  value: string,
  opts: { digitRuns?: boolean; town?: boolean; atTokens?: boolean; handles?: boolean } = {},
): boolean {
  return contactValueVerdict(value, opts) !== 'none';
}

/**
 * The contact verdict on a cell: `contact`, `none`, or `undecidable` — the bounded address search
 * could not decide within its budget, which fails CLOSED (DECISION_LOG 6bff30e): an optional cell
 * is dropped like a contact value, and a name refuses the row (`contact_value_undecidable`).
 */
export function contactValueVerdict(
  value: string | readonly string[],
  opts: { digitRuns?: boolean; town?: boolean; atTokens?: boolean; handles?: boolean } = {},
): 'contact' | 'none' | 'undecidable' {
  // One verdict per distinct cell text and options within a row (a row repeats its texts); the
  // row's work budget is charged only on a miss. The memo belongs to the row: it is emptied when a
  // new row begins and never cleared mid-row, so a row's charge never depends on what was mapped
  // before it (DECISION_LOG ed7b71a (5)). Outside a row nothing is memoised.
  if (rowBudgetLeft() === null) return computeContactVerdict(value, opts);
  if (verdictRow !== currentRow()) {
    ROW_VERDICTS.clear();
    verdictRow = currentRow();
  }
  const key = `${JSON.stringify(opts)}|${typeof value === 'string' ? value : value.join('\u0000')}`;
  const cached = ROW_VERDICTS.get(key);
  if (cached) return cached;
  const verdict = computeContactVerdict(value, opts);
  ROW_VERDICTS.set(key, verdict);
  return verdict;
}
/** Verdicts memoised within the current row (`verdictRow`); emptied when a new row begins. */
const ROW_VERDICTS = new Map<string, 'contact' | 'none' | 'undecidable'>();
let verdictRow = -1;

function computeContactVerdict(
  value: string | readonly string[],
  opts: { digitRuns?: boolean; town?: boolean; atTokens?: boolean; handles?: boolean },
): 'contact' | 'none' | 'undecidable' {
  const t: Tracker = { undecided: false };
  try {
    // One or more forms of one cell (its canonical form and the cell as written): their readings
    // are pooled and deduplicated (whitespace runs collapsed), so a form adds only new readings.
    const decodedForms = [...new Set((typeof value === 'string' ? [value] : value).map(decodeEscapes))];
    // The raw (decoded) text, the text with zero-width characters removed, and with them turned
    // into spaces (DECISION_LOG af1b342); and the skeletons (DECISION_LOG 64d97b4). A hit on any
    // reading counts.
    const variants = [
      ...new Set(
        decodedForms
          .flatMap((d) => [d, contactText(d), contactText(d, 'space'), ...skeletons(d)])
          .map((v) => v.replace(/\s+/g, ' ').trim()),
      ),
    ];
    // Every reading's scans are charged to the row's budget (one unit per 8 characters).
    if (variants.some((v) => (chargeRow(Math.ceil(v.length / 8) + 1), contactValueIn(v, opts, t))))
      return 'contact';
    // The name keys derived from a name, legal name or town (`name:<strict key>`): a key must not
    // read as an address or hold 9+ digits either (`jane at acme\u200bdot\u200bcom`, `07700ß900123`).
    if (opts.digitRuns || opts.town)
      for (const key of new Set(decodedForms.flatMap((d) => [strictNameKey(d), looseNameKey(d)])))
        if (key && ((!variants.includes(key) && grammar(key, {}, t)) || longestDigitRun(key) >= 9))
          return 'contact';
    return 'none';
  } catch (err) {
    if (err === UNDECIDED && t.undecided) return 'undecidable';
    // The row's work budget is spent (DECISION_LOG 47c0f5c): the cell is undecidable.
    if (err instanceof RowBudgetExhausted) return 'undecidable';
    throw err;
  }
}
function contactValueIn(
  v: string,
  opts: { digitRuns?: boolean; town?: boolean; atTokens?: boolean; handles?: boolean },
  t: Tracker,
): boolean {
  if (/(?:^|[^\p{L}])mailto(?:[^\p{L}]|$)/iu.test(v) || PROFILE_LINK_IN_TEXT.test(v)) return true;
  return (
    hasEmailLike(v, opts.atTokens !== false, t) ||
    CONTACT_SCHEME.test(v) ||
    (opts.handles === true && hasHandle(v)) ||
    CONTACT_LINK_IN_TEXT.test(v) ||
    hasPhoneNumber(v) ||
    (!!(opts.digitRuns || opts.town) &&
      (longestDigitRun(v) >= 9 || hasLongDigitRun(v, opts.town ? 6 : undefined)))
  );
}

/** Whether a value holds any digit of any script (a town may hold none). */
export function hasDigit(value: string): boolean {
  return /\p{Nd}/u.test(value.normalize('NFKC'));
}

/** Percent-decodes until the text no longer changes (at most 5 rounds; `%2540` → `%40` → `@`). */
export function decodeStable(s: string): string {
  let cur = s;
  for (let k = 0; k < 5; k++) {
    // Each run of escapes separately, so one invalid escape cannot shield the rest; an invalid
    // UTF-8 run still has its ASCII escapes (`%40` → `@`) decoded.
    const next = cur.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run.replace(/%([0-7][0-9a-f])/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      }
    });
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * Whether a URL or domain cell carries a contact value: credentials (`user:pw@`), an email
 * address used as the "domain", a contact URI, or an email / phone number anywhere in its path,
 * query or fragment (decoded until stable).
 */
/** Hosts of ATS job links whose posting id is set aside by `urlHasContactValue` (OPS-5). */
const ATS_JOB_HOSTS = new Set([
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
  'jobs.ashbyhq.com',
  'jobs.lever.co',
  'jobs.eu.lever.co',
]);

/**
 * `opts.atsJobIds` (OPS-5, job URL and board files only): the posting id of a job link on an ATS
 * host is set aside. Company-file URL cells keep the stricter rule (DECISION_LOG 621f14c).
 */
export function urlHasContactValue(value: string, opts: { atsJobIds?: boolean } = {}): boolean {
  // Any `@`-like character anywhere in a URL or domain cell (`https://acme.com\@gmail.com`), after
  // HTML entities and percent-escapes are decoded until stable (`jane&commat;acme.com`,
  // `jane%26commat%3Bacme.com`); and every other contact value in the decoded cell except the
  // `at` notation (`jobs-at-acme.com` is a real host; DECISION_LOG b24e5dd, a documented residual).
  const dv = decodeEscapes(value);
  if (AT_LIKE.test(value.normalize('NFKC')) || AT_LIKE.test(dv) || AT_LIKE.test(dv.normalize('NFKC')))
    return true;
  if (hasContactValue(dv, { atTokens: false })) return true;
  const v = contactText(value.trim());
  if (/^(?:mailto|tel|sms|callto|whatsapp|skype):/i.test(v)) return true;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    // Not a URL: an `@` before any path is still a mailbox.
    return /^[^/]*@/.test(v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')) || hasContactValue(v);
  }
  if (u.username || u.password) return true;
  if (onHost(u.hostname.toLowerCase(), CONTACT_LINK_HOSTS)) return true;
  // The host, decoded (the URL parser percent-decodes it; entities are decoded here): an `@`-like
  // character, any other contact value except the `at` notation, and 9+ digits separated only by
  // non-letters (`07700900123.acme.com`, `call-07700-900123.acme.co.uk`).
  const host = decodeEscapes(u.hostname);
  if (AT_LIKE.test(host) || hasContactValue(host, { atTokens: false }) || longestDigitRun(host) >= 9)
    return true;
  // Every path is scanned raw and decoded first, before any id is set aside (DECISION_LOG
  // 621f14c): a digits-only segment shaped like a phone number (10–13 digits starting 0, 00 or
  // 44), and an email, phone or handle anywhere in the path (a LinkedIn job slug included).
  const decoded = decodeStable(u.pathname);
  for (const p of [u.pathname, decoded, normalizedPath(decoded)]) {
    if (p.split('/').some((seg) => /^(?=\d{10,13}$)(?:0|44)\d+$/.test(seg.replace(/^\+/, '')))) return true;
    if (hasContactValue(p)) return true;
  }
  // Structural: 9+ digits separated only by non-letters in the decoded path is a phone
  // (`/call/020–7946–0958`, `/c/44-7700-900123`, `/j/1234567890`). The only id set aside — after
  // the slug was scanned above — is a trailing LinkedIn-shaped id: a company id of at most 9 digits
  // ending `/company/<id>`, or a job id of exactly 10 digits ending `/jobs/view/<slug>-<id>` that
  // does not start with 7 (`7` + 9 digits is a UK mobile without its leading 0).
  const lowerHost = u.hostname.toLowerCase().replace(/\.$/, '');
  const digitPath = isLinkedIn(lowerHost)
    ? normalizedPath(decoded)
        .replace(/^(\/company\/)[1-9]\d{0,8}(?=\/|$)/i, '$1_')
        .replace(/^(\/jobs\/view\/(?:[\p{L}\p{N}-]*-)?)(?!7)[1-9]\d{9}(?=\/|$)/iu, '$1_')
    : opts.atsJobIds && ATS_JOB_HOSTS.has(lowerHost)
      ? // OPS-5: an ATS job link's own posting id (after the slug and the phone-shaped segment
        // checks above): Greenhouse `/<board>/jobs/<id>` (digits not starting 0 or 7), Ashby and
        // Lever `/<board>/<uuid>`.
        normalizedPath(decoded)
          .replace(/^(\/[^/]+\/jobs\/)(?![07])[1-9]\d{5,15}(?=\/|$)/, '$1_')
          .replace(/^(\/[^/]+\/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/i, '$1_')
      : decoded;
  if (longestDigitRun(digitPath) >= 9) return true;
  // A person's page or card (`/team/jane-smith`, `/people/…`, `….vcf`).
  const segments = normalizedPath(decoded).toLowerCase().split('/').filter(Boolean);
  if (segments.some((seg, k) => PERSON_PATH_SEGMENTS.has(seg) && k + 1 < segments.length)) return true;
  if (segments.some((seg) => /\.(?:vcf|vcard)$/.test(seg))) return true;
  // In the query a `+` may be a space.
  const parts = [decodeStable(u.search), decodeStable(u.search.replace(/\+/g, ' ')), decodeStable(u.hash)];
  return parts.some((p) => hasContactValue(p));
}

/** Placeholder text that means "no value". */
const PLACEHOLDERS = new Set([
  '-',
  '--',
  '–',
  '—',
  'n/a',
  'n.a.',
  'n.a',
  'na',
  'n/k',
  'nk',
  'none',
  'nil',
  'null',
  'nan',
  'undefined',
  'unknown',
  'not known',
  'not applicable',
  'not provided',
  'not specified',
  'not given',
  'unspecified',
  'tbc',
  'tba',
  'tbd',
  '?',
  '.',
]);

/** Spreadsheet error values (`#N/A`, `#VALUE!`, `#REF!`, `#DIV/0!`, `#NAME?`, …). */
const SPREADSHEET_ERROR =
  /^#(?:n\/a|value!|ref!|div\/0!|name\?|null!|num!|spill!|calc!|field!|blocked!|busy!|connect!|unknown!|getting_data|n\/a\s*\(.*\))$/i;

/**
 * Whether a cell is a placeholder (counts as absent): `-`, `n/a`, `unknown`, `tbc`, `nan`,
 * `null`, `undefined`, `not provided`, spreadsheet errors (`#N/A`, `#REF!`), runs of `x`
 * (`xx`, `XXX`), zeros only (`0`, `000`), punctuation only.
 */
export function isPlaceholder(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const v = value
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .trim()
    .toLowerCase();
  if (!v) return true;
  return (
    PLACEHOLDERS.has(v) ||
    SPREADSHEET_ERROR.test(v) ||
    /^x{2,}$/.test(v) ||
    /^0+$/.test(v) ||
    /^[\p{P}\p{S}\s]+$/u.test(v)
  );
}

/**
 * Whether a town cell is a placeholder: any placeholder, a single `x`, `various`, `other`,
 * `multiple`, or fewer than 2 letters.
 */
export function isPlaceholderTown(value: string | null | undefined): boolean {
  if (isPlaceholder(value)) return true;
  const v = value!.normalize('NFKC').trim().toLowerCase();
  if (['x', 'various', 'other', 'others', 'multiple', 'several', 'misc'].includes(v)) return true;
  return (v.match(/\p{L}/gu) ?? []).length < 2;
}

/**
 * Whether a normalised register id is a placeholder (counts as absent, never identity): all zeros
 * (`00000000`, `SC000000`, `00-0000000`), in any namespace. Repeated or sequential digits are NOT
 * placeholders: such numbers can be really issued (DECISION_LOG "Company directory identity is
 * structural").
 */
export function isPlaceholderId(id: string): boolean {
  const digits = id.replace(/\D/g, '');
  return digits.length > 0 && /^0+$/.test(digits);
}

/** Social and profile hosts: a careers URL there is dropped unless it is an organisation or jobs page. */
const PROFILE_HOSTS = [
  'linkedin.com',
  'facebook.com',
  'fb.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'github.com',
  'gitlab.com',
  'about.me',
  'linktr.ee',
  'medium.com',
  'substack.com',
  'tiktok.com',
  'youtube.com',
  'xing.com',
  'pinterest.com',
  'threads.net',
  'bsky.app',
  'mastodon.social',
  'wellfound.com',
  'angel.co',
  'behance.net',
  'dribbble.com',
];

/** Organisation and jobs pages on profile hosts (kept as careers URLs). */
const ORGANISATION_PATHS: Array<[string, RegExp]> = [
  ['linkedin.com', /^\/(?:company|school|showcase)\/[^/]+(?:\/|$)|^\/jobs(?:\/|$)/i],
  ['wellfound.com', /^\/(?:company\/[^/]+|jobs|role)(?:\/|$)/i],
  ['angel.co', /^\/(?:company\/[^/]+|jobs)(?:\/|$)/i],
  ['dribbble.com', /^\/jobs(?:\/|$)/i],
  ['behance.net', /^\/joblist(?:\/|$)/i],
];

/** Person markers in a profile-host path (`/in/…`, `/pub/…`, `/u/…`). */
const PERSON_MARKERS = new Set(['in', 'pub', 'u']);

const isLinkedIn = (host: string) => host === 'linkedin.com' || host.endsWith('.linkedin.com');

/** A URL path with repeated slashes collapsed (`/company//in/jane` → `/company/in/jane`). */
function normalizedPath(path: string): string {
  return path.replace(/\/{2,}/g, '/');
}

/**
 * Whether a careers URL is a person's social or profile page (DECISION_LOG re-verification #6):
 * any page on a social/profile host (linkedin.com/in/…, /pub/…, facebook, twitter/x, instagram,
 * github, about.me, linktr.ee, *.medium.com, wellfound/angel.co, behance, dribbble, …) except an
 * organisation or jobs page (`linkedin.com/company/…`, `/school/…`, `/jobs/…`, `wellfound.com/company/…`,
 * `dribbble.com/jobs`, …). The path is normalised first (`//` collapsed), and a person marker
 * (`/in/`, `/pub/`, `/u/`) anywhere in it is a profile (DECISION_LOG c1a3500).
 */
export function isProfileUrl(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  const on = (h: string) => host === h || host.endsWith(`.${h}`);
  if (!PROFILE_HOSTS.some(on)) return false;
  const path = normalizedPath(decodeStable(u.pathname));
  const segments = path.toLowerCase().split('/').filter(Boolean);
  // A person marker anywhere in the path is a profile (`linkedin.com/company//in/jane`).
  if (segments.some((seg) => PERSON_MARKERS.has(seg))) return true;
  return !ORGANISATION_PATHS.some(([h, re]) => on(h) && re.test(path));
}
