import { load } from 'cheerio';
import { getAdapter, regionOfApiBase } from '../connectors';
import type { AtsProvider } from '../contracts/common';

export type DetectionConfidence = 'high' | 'medium' | 'low';

/** A board reference found in a URL: provider, token and the provider API base of its region. */
export interface AtsBoardRef {
  provider: AtsProvider;
  boardToken: string;
  /**
   * The provider's public API base for the board's region (M6.3), e.g.
   * `https://boards-api.eu.greenhouse.io/v1/boards` for a `boards.eu.greenhouse.io` board. An EU
   * board does not exist on the default host, so registration, fetch and verification use this.
   */
  apiBase: string;
}

export interface AtsDetection extends AtsBoardRef {
  confidence: DetectionConfidence;
  /** The matched URL or snippet (≤200 chars). */
  evidence: string;
}

/** Path segments that appear where a board token would, but are never one. */
const GENERIC_TOKENS = new Set([
  'embed',
  'v0',
  'v1',
  'jobs',
  'job',
  'job_board',
  'job-board',
  'job_app',
  'boards',
  'board',
  'api',
  'posting-api',
  'postings',
  'js',
  'apply',
  'application',
  'careers',
  'static',
  'assets',
  'search',
  'login',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
]);

const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_EVIDENCE = 200;
const RANK: Record<DetectionConfidence, number> = { high: 3, medium: 2, low: 1 };

function cleanToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let token: string;
  try {
    token = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  if (!TOKEN_PATTERN.test(token) || GENERIC_TOKENS.has(token.toLowerCase())) return null;
  return token;
}

/** Parse absolute, protocol-relative or scheme-less URLs; null when unparseable or not http(s). */
function toUrl(input: string, base?: string): URL | null {
  let candidate = input.trim();
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !base && /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const url = base ? new URL(candidate, base) : new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Region of an ATS host: `eu` for the EU data-centre hosts (`*.eu.greenhouse.io`, `*.eu.lever.co`). */
function regionOfHost(host: string): 'default' | 'eu' {
  return /\.eu\.(greenhouse\.io|lever\.co)$/.test(host) ? 'eu' : 'default';
}

/** Identify a Greenhouse, Lever or Ashby board from one URL (job board page, embed script or API endpoint). */
export function detectAtsFromUrl(url: string): AtsBoardRef | null {
  const parsed = toUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);
  const [first, second, third] = segments;
  const hit = (provider: AtsProvider, raw: string | null | undefined): AtsBoardRef | null => {
    const boardToken = cleanToken(raw);
    if (!boardToken) return null;
    const bases = getAdapter(provider).apiBases;
    return { provider, boardToken, apiBase: bases[regionOfHost(host)] ?? bases.default };
  };

  if (host === 'greenhouse.io' || host.endsWith('.greenhouse.io')) {
    // Embeds: /embed/job_board?for=acme, /embed/job_board/js?for=acme, /embed/job_app?for=acme&token=…
    if (first === 'embed') return hit('greenhouse', parsed.searchParams.get('for'));
    if (/^boards-api(\.eu)?\.greenhouse\.io$/.test(host)) {
      return first === 'v1' && second === 'boards' ? hit('greenhouse', third) : null;
    }
    if (/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(host)) return hit('greenhouse', first);
    return null;
  }
  if (/^jobs(\.eu)?\.lever\.co$/.test(host)) return hit('lever', first);
  if (/^api(\.eu)?\.lever\.co$/.test(host)) {
    return first === 'v0' && second === 'postings' ? hit('lever', third) : null;
  }
  if (host === 'jobs.ashbyhq.com') return hit('ashby', first);
  if (host === 'api.ashbyhq.com') {
    return first === 'posting-api' && second === 'job-board' ? hit('ashby', third) : null;
  }
  return null;
}

const URL_ATTRIBUTES = ['href', 'src', 'action', 'data-src', 'data-href', 'data-url'];
const RAW_ATS_URL = /(?:https?:)?\/\/[a-z0-9.-]*(?:greenhouse\.io|lever\.co|ashbyhq\.com)[^\s"'<>\\`)]*/gi;
/** Greenhouse embed configured in script without a literal board URL, e.g. `Grnhse.Settings = { boardToken: 'acme' }`. */
const GRNHSE_SETTING = /grnhse[\s\S]{0,400}?(?:\bfor|boardToken)\s*[:=]\s*['"]?([A-Za-z0-9_-]+)/gi;

function truncate(text: string): string {
  return text.length > MAX_EVIDENCE ? `${text.slice(0, MAX_EVIDENCE - 1)}…` : text;
}

/**
 * ATS detections of one company, deduplicated by provider, REGION and token (A-L3): board tokens
 * are per data centre, so `acme` on the EU host and `acme` on the default host are different
 * boards. A detection of the same board keeps the strongest confidence (first seen on a tie).
 * A `low` detection (a Greenhouse embed setting: no URL, so no region) is a guess of the default
 * host: it yields to any explicit URL detection of the same provider + token, in any region.
 */
export class AtsDetectionSet {
  private readonly found = new Map<string, AtsDetection & { order: number }>();
  private next = 0;

  add(detection: AtsDetection): void {
    const board = `${detection.provider}:${detection.boardToken.toLowerCase()}`;
    const sameBoard = [...this.found.entries()].filter(([, d]) => boardOf(d) === board);
    if (detection.confidence === 'low') {
      if (sameBoard.length) return;
    } else {
      for (const [key, d] of sameBoard) if (d.confidence === 'low') this.found.delete(key);
    }
    const key = `${detection.provider}:${regionOf(detection)}:${detection.boardToken.toLowerCase()}`;
    const existing = this.found.get(key);
    if (existing && RANK[existing.confidence] >= RANK[detection.confidence]) return;
    this.found.set(key, { ...detection, order: existing?.order ?? this.next++ });
  }

  /** Strongest first, then first seen. */
  list(): AtsDetection[] {
    return [...this.found.values()]
      .sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || a.order - b.order)
      .map(({ order: _order, ...detection }) => detection);
  }
}

function boardOf(d: AtsBoardRef): string {
  return `${d.provider}:${d.boardToken.toLowerCase()}`;
}

/** Region name of a detection's API base (`default`, `eu`), or the base itself when unknown. */
function regionOf(d: AtsBoardRef): string {
  return regionOfApiBase(getAdapter(d.provider), d.apiBase) ?? d.apiBase;
}

/**
 * Detect ATS boards referenced by a page: the page URL itself, link/embed attributes (high),
 * ATS URLs inside inline scripts or text (medium) and Greenhouse embed settings (low).
 * Deduplicated by provider, region and token (`AtsDetectionSet`); strongest first.
 */
export function detectAts(html: string, pageUrl: string): AtsDetection[] {
  const found = new AtsDetectionSet();
  const add = (detection: AtsBoardRef | null, confidence: DetectionConfidence, evidence: string) => {
    if (detection) found.add({ ...detection, confidence, evidence: truncate(evidence) });
  };

  add(detectAtsFromUrl(pageUrl), 'high', pageUrl);

  const $ = load(html, { scriptingEnabled: false });
  // Document order, so the first reference to a board becomes its evidence.
  $(URL_ATTRIBUTES.map((attr) => `[${attr}]`).join(',')).each((_, el) => {
    for (const attr of URL_ATTRIBUTES) {
      const value = $(el).attr(attr);
      const url = value ? toUrl(value, pageUrl) : null;
      if (url) add(detectAtsFromUrl(url.href), 'high', url.href);
    }
  });

  for (const match of html.matchAll(RAW_ATS_URL)) {
    const raw = match[0].replace(/&amp;/g, '&');
    add(detectAtsFromUrl(raw), 'medium', raw);
  }

  for (const match of html.matchAll(GRNHSE_SETTING)) {
    // No URL, so no region: a guess of the default host (low confidence). An explicit URL of the
    // same board, in any region, wins over it (`AtsDetectionSet`).
    const boardToken = cleanToken(match[1]);
    add(
      boardToken
        ? { provider: 'greenhouse', boardToken, apiBase: getAdapter('greenhouse').apiBases.default }
        : null,
      'low',
      match[0].replace(/\s+/g, ' '),
    );
  }

  return found.list();
}
