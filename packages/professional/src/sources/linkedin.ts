/**
 * LinkedIn is accepted only as a subject-supplied export file (PL-11): no login, scraping or
 * fetching of its hosts, for any source kind. This is the single deny-list; the source schema,
 * the source collection's server-side validator and (P6) the fetch capability all use it.
 * Hosts: the site, its China site, its link shortener and its static-content CDN.
 */
export const LINKEDIN_HOSTS = ['linkedin.com', 'linkedin.cn', 'lnkd.in', 'licdn.com'] as const;

const hostAlternation = LINKEDIN_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|');

/** A LinkedIn host or any subdomain (case-insensitive, optional trailing dot). */
export const LINKEDIN_HOST_REGEX_SOURCE = `^([^.]+\\.)*(${hostAlternation})\\.?$`;

/** An absolute URL whose host is a LinkedIn host (userinfo and port tolerated). */
export const LINKEDIN_URL_REGEX_SOURCE = `^[a-z][a-z0-9+.-]*://([^/?#@]*@)?([^/?#:@]*\\.)?(${hostAlternation})\\.?(:[0-9]*)?([/?#]|$)`;

const HOST_RE = new RegExp(LINKEDIN_HOST_REGEX_SOURCE, 'i');
const URL_RE = new RegExp(LINKEDIN_URL_REGEX_SOURCE, 'i');

export function isLinkedInHost(host: string): boolean {
  return HOST_RE.test(host.trim());
}

/** True when the URL points at a LinkedIn host (parsed; the regex covers unparsable input). */
export function isLinkedInUrl(url: string): boolean {
  try {
    if (isLinkedInHost(new URL(url).hostname)) return true;
  } catch {
    /* not parsable: fall through to the textual check */
  }
  return URL_RE.test(url.trim());
}
