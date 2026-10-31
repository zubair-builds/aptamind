/**
 * HTTP basic auth for the whole admin (pages AND `/api/*`). Edge-runtime safe: no Node APIs.
 * Enabled only when `ADMIN_PASSWORD` is set; the username is ignored.
 */

/** Paths that stay public: liveness only (no data). Everything else requires auth. */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/health']);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

/** Constant-time comparison: hashes both sides so length and content never short-circuit. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  return diff === 0;
}

/** Password from a `Basic` Authorization header, or null when absent/malformed. */
export function basicPassword(header: string | null): string | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    const bin = atob(match[1]);
    decoded = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  return colon >= 0 ? decoded.slice(colon + 1) : null;
}

export async function isAuthorized(header: string | null, password: string): Promise<boolean> {
  const given = basicPassword(header);
  // Always run the comparison so timing does not reveal whether a header was sent.
  const ok = await safeEqual(given ?? '', password);
  return given !== null && ok;
}
