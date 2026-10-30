import { parse } from 'tldts';

/**
 * Registrable domains that never identify a company's own website: social networks, job boards,
 * registries, encyclopaedias and hosted-ATS platforms. A link to one of these is not a company domain.
 */
export const NON_COMPANY_DOMAINS: ReadonlySet<string> = new Set([
  'linkedin.com',
  'lnkd.in',
  'facebook.com',
  'fb.com',
  'twitter.com',
  'x.com',
  't.co',
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'github.com',
  'medium.com',
  'crunchbase.com',
  'wikipedia.org',
  'wikimedia.org',
  'goo.gl',
  'bit.ly',
  'companieshouse.gov.uk',
  'opencorporates.com',
  'wellfound.com',
  'angel.co',
  'ycombinator.com',
  'monster.com',
  'reed.co.uk',
  'totaljobs.com',
  'ziprecruiter.com',
  'simplyhired.com',
  'workable.com',
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'smartrecruiters.com',
  'myworkdayjobs.com',
  'bamboohr.com',
  'recruitee.com',
  'teamtailor.com',
  'personio.de',
  'personio.com',
]);

/** Brands blocked under any public suffix (glassdoor.co.uk, indeed.de, …). */
export const NON_COMPANY_DOMAIN_LABELS: ReadonlySet<string> = new Set([
  'glassdoor',
  'indeed',
  'linkedin',
  'wikipedia',
  'facebook',
  'stepstone',
]);

/** Public suffixes reserved for government bodies rather than companies. */
export const NON_COMPANY_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'gov',
  'gov.uk',
  'service.gov.uk',
  'nhs.uk',
  'police.uk',
  'mil',
  'gouv.fr',
  'gov.au',
  'gc.ca',
  'gov.ie',
  'europa.eu',
]);

/** True when a registrable domain belongs to a non-company host (see the blocklists above). */
export function isNonCompanyDomain(domain: string): boolean {
  const parsed = parse(domain);
  if (!parsed.domain) return true;
  if (NON_COMPANY_DOMAINS.has(parsed.domain)) return true;
  if (parsed.domainWithoutSuffix && NON_COMPANY_DOMAIN_LABELS.has(parsed.domainWithoutSuffix)) return true;
  const suffix = parsed.publicSuffix ?? '';
  return [...NON_COMPANY_PUBLIC_SUFFIXES].some((s) => suffix === s || suffix.endsWith(`.${s}`));
}

/**
 * Registrable domain (eTLD+1) of a URL, hostname or email address, lowercased.
 * Returns null for IPs, unknown TLDs, unparseable input and known non-company hosts.
 */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const parsed = parse(trimmed);
  if (parsed.isIp || !parsed.isIcann || !parsed.domain) return null;
  const domain = parsed.domain.replace(/^www\./, '');
  if (!domain.includes('.') || isNonCompanyDomain(domain)) return null;
  return domain;
}
