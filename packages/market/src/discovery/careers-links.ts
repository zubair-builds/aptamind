import { getDomain } from 'tldts';
import { extractAnchors, urlKey } from './anchors';
import { detectAtsFromUrl } from './ats-detect';
import { isNonCompanyDomain, normalizeDomain } from './domain';

export interface CareersLink {
  url: string;
  text: string;
  score: number;
  reasons: string[];
}

/** Anchor texts that are, on their own, a careers link. */
const EXACT_TEXT = new Set([
  'careers',
  'career',
  'jobs',
  'join us',
  'join our team',
  'join the team',
  'work with us',
  'work for us',
  'open positions',
  'open roles',
  'open jobs',
  'job openings',
  'current openings',
  'vacancies',
  'current vacancies',
  "we're hiring",
  'we are hiring',
  'hiring',
]);
const TEXT_SIGNAL =
  /\b(careers?|jobs|join (us|our team|the team)|work (with|for) us|open (positions|roles|jobs)|job openings|vacanc(y|ies)|we're hiring|we are hiring|hiring)\b/;
const PATH_SEGMENT =
  /^(careers?|jobs|join-?us|join|work-?with-?us|work-?for-?us|vacancies|open-?positions|open-?roles|openings|positions|hiring)$/;
const PATH_PARTIAL = /career|job|vacanc|hiring/;
const EDITORIAL_PATH =
  /(^|\/)(blog|news|press|articles?|posts?|insights|stories|media|resources|events)(\/|$)/;
const CAREERS_SUBDOMAIN = /^(careers?|jobs|join|work)\./;
const MIN_SCORE = 3;

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Rank a page's anchors as candidate careers pages. Text and URL signals add up; same-site links and
 * links to known ATS boards are strongly preferred; self-links are ignored; editorial paths and off-site links are penalised; links to
 * non-company hosts (LinkedIn, Glassdoor…) are excluded. Deduplicated by URL, best first.
 */
export function findCareersLinks(html: string, pageUrl: string): CareersLink[] {
  let pageSite: string | null;
  try {
    pageSite = getDomain(new URL(pageUrl).hostname);
  } catch {
    return [];
  }
  const pageKey = urlKey(new URL(pageUrl));
  const best = new Map<string, CareersLink>();

  for (const { url, text } of extractAnchors(html, pageUrl)) {
    const key = urlKey(url);
    if (key === pageKey) continue;
    const site = getDomain(url.hostname);
    const ats = detectAtsFromUrl(url.href);
    if (!ats && (!site || isNonCompanyDomain(site))) continue;

    let score = 0;
    const reasons: string[] = [];
    let signal = false;
    const bump = (points: number, reason: string, isSignal = false) => {
      score += points;
      reasons.push(reason);
      signal ||= isSignal;
    };

    const normalized = normalizeText(text);
    if (EXACT_TEXT.has(normalized)) bump(5, 'text_exact', true);
    else if (TEXT_SIGNAL.test(normalized)) bump(3, 'text_keyword', true);

    const path = url.pathname.toLowerCase();
    const segments = path.split('/').filter(Boolean);
    if (segments.slice(0, 2).some((s) => PATH_SEGMENT.test(s))) bump(4, 'url_path', true);
    else if (PATH_PARTIAL.test(path)) bump(2, 'url_keyword', true);

    const sameSite = site !== null && site === pageSite;
    if (ats) bump(8, `ats_host:${ats.provider}`, true);
    else if (sameSite) bump(2, 'same_site');
    else bump(-3, 'external_site');
    if (sameSite && CAREERS_SUBDOMAIN.test(url.hostname.toLowerCase())) bump(3, 'careers_subdomain', true);

    if (EDITORIAL_PATH.test(path)) bump(-5, 'editorial_path');
    if (text.length > 40) bump(-2, 'long_text');
    if (segments.length > 3 && !ats) bump(-1, 'deep_path');

    if (!signal || score < MIN_SCORE) continue;
    const existing = best.get(key);
    if (existing && existing.score >= score) {
      if (!existing.text && text) existing.text = text;
      continue;
    }
    best.set(key, { url: url.href, text: text || existing?.text || '', score, reasons });
  }

  return [...best.values()].sort((a, b) => b.score - a.score || a.url.length - b.url.length);
}

/** Conventional careers URLs to probe for a company domain, most likely first. */
export function candidateCareersPaths(domain: string): string[] {
  const d = normalizeDomain(domain);
  if (!d) return [];
  return [
    `https://${d}/careers`,
    `https://${d}/jobs`,
    `https://${d}/careers/`,
    `https://${d}/join-us`,
    `https://${d}/company/careers`,
    `https://${d}/about/careers`,
    `https://${d}/work-with-us`,
    `https://careers.${d}/`,
    `https://jobs.${d}/`,
  ];
}
