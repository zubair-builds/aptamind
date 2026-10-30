import { load } from 'cheerio';

export interface PageAnchor {
  /** Absolute http(s) URL with the fragment removed. */
  url: URL;
  /** Visible text (falling back to aria-label, title or image alt), whitespace-collapsed. */
  text: string;
}

/**
 * Absolute http(s) anchors on a page. Drops mailto:/tel:/javascript: links and fragment-only links
 * (`#top`, or a fragment pointing back at the page itself).
 */
export function extractAnchors(html: string, pageUrl: string): PageAnchor[] {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return [];
  }
  // Parse <noscript> content as markup: fallback board links often live there.
  const $ = load(html, { scriptingEnabled: false });
  const anchors: PageAnchor[] = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || href.startsWith('#')) return;
    let url: URL;
    try {
      url = new URL(href, page);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    const hadFragment = url.hash !== '';
    url.hash = '';
    if (hadFragment && url.href === withoutHash(page)) return;
    const $el = $(el);
    const text = collapse(
      $el.text() || $el.attr('aria-label') || $el.attr('title') || $el.find('img[alt]').attr('alt') || '',
    );
    anchors.push({ url, text });
  });
  return anchors;
}

/** Stable comparison key: lowercase host, no fragment, no trailing slash (except root). */
export function urlKey(url: URL): string {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}

function withoutHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return copy.href;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
