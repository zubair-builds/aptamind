import type { CopyBoard } from './job.schema';

/** `https://Host/path/?q#f` → `https://host/path` (query and fragment dropped). Unparseable: as given. */
function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.trim();
  }
}

/**
 * The canonical identity of a board (DECISION_LOG 15c965b): provider, API base and board token —
 * not the raw endpoint URL, so `…/jobs?content=true` and `…/jobs`, a trailing slash or host case
 * are the same board. A board whose API base is unknown (a careers page, or an ATS URL the API
 * base could not be recovered from) is identified by its canonical endpoint URL instead.
 */
export function boardIdentity(b: CopyBoard): string {
  const base = b.apiBase ? b.apiBase.replace(/\/+$/, '') : b.endpointUrl ? canonicalUrl(b.endpointUrl) : '';
  return `${base}|${b.boardToken ?? ''}`;
}

/** The same board by canonical identity (and provider, when both name one). Unknown matches nothing. */
export function sameBoard(a: CopyBoard | null | undefined, b: CopyBoard | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.provider && b.provider && a.provider !== b.provider) return false;
  return boardIdentity(a) === boardIdentity(b);
}
