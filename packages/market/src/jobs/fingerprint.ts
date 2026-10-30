import { createHash } from 'node:crypto';

/**
 * Fingerprints used by job entity resolution.
 */

const TRACKING_PARAMS = /^(utm_|gh_src|gh_jid$|lever-source|source$|ref$|src$|trk|fbclid|gclid|mc_|_hs)/i;

/** Normalised URL for equality: lower-case host, no www, no fragment, no tracking params, no trailing slash. */
export function urlFingerprint(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const u = new URL(input);
    u.hash = '';
    const keep = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAMS.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const qs = keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${path}${qs ? `?${qs}` : ''}`;
  } catch {
    return null;
  }
}

export function normalizeTitleKey(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(remote|hybrid|onsite|on-site|m\/f\/d|f\/m\/d|m\/w\/d|w\/m\/d)\b/g, ' ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function locationKey(locations: string[]): string {
  return [
    ...new Set(
      locations
        .map((l) =>
          l
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim(),
        )
        .filter(Boolean),
    ),
  ]
    .sort()
    .join('|');
}

/** 5-word shingles hashed to 32-bit ints (sorted, capped) for Jaccard similarity of descriptions. */
export function shingles(text: string, max = 400): number[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  const set = new Set<number>();
  for (let i = 0; i + 5 <= words.length; i++) {
    const h = createHash('md5')
      .update(words.slice(i, i + 5).join(' '))
      .digest();
    set.add(h.readInt32BE(0));
  }
  if (set.size === 0 && words.length)
    set.add(createHash('md5').update(words.join(' ')).digest().readInt32BE(0));
  // Keep the smallest hashes (a MinHash-style bottom-k sketch) so the sketch is stable.
  return [...set].sort((a, b) => a - b).slice(0, max);
}

export function jaccard(a: number[], b: number[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  let inter = 0;
  for (const x of b) if (sa.has(x)) inter++;
  return inter / (sa.size + b.length - inter);
}
