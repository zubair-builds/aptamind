import { extractAnchors, urlKey } from './anchors';

/** Section keywords after which a further path segment usually names one job. */
const JOB_SECTION = /^(job|jobs|careers?|positions?|openings?|vacanc(y|ies)|roles?|opportunities)$/;

/** Slugs under a careers section that are sub-pages rather than job postings. */
const NON_JOB_SLUGS = new Set([
  'search',
  'page',
  'category',
  'categories',
  'department',
  'departments',
  'location',
  'locations',
  'team',
  'teams',
  'benefits',
  'culture',
  'life',
  'values',
  'students',
  'graduates',
  'internships',
  'faq',
  'faqs',
  'alerts',
  'job-alerts',
  'feed',
  'rss',
  'login',
  'register',
  'apply',
  'privacy',
  'saved',
  'all',
]);

/**
 * Links to individual job detail pages on a generic (non-ATS) careers page: same host only, a job
 * section segment (/jobs/, /careers/, /positions/, …) followed by a job-specific slug.
 */
export function findJobDetailLinks(html: string, pageUrl: string): string[] {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return [];
  }
  const pageKey = urlKey(page);
  const seen = new Set<string>();
  const links: string[] = [];
  for (const { url } of extractAnchors(html, pageUrl)) {
    if (url.hostname.toLowerCase() !== page.hostname.toLowerCase()) continue;
    const key = urlKey(url);
    if (key === pageKey || seen.has(key)) continue;
    const segments = url.pathname.toLowerCase().split('/').filter(Boolean);
    const sectionIndex = segments.findIndex((s) => JOB_SECTION.test(s));
    const slug = sectionIndex >= 0 ? segments[sectionIndex + 1] : undefined;
    if (!slug || NON_JOB_SLUGS.has(slug) || JOB_SECTION.test(slug)) continue;
    seen.add(key);
    links.push(url.href);
  }
  return links;
}
