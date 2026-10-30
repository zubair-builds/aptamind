/** Pure formatting helpers (safe on server and client). */

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  const s = abs / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ${Math.round(s % 60)}s`;
  const h = m / 60;
  if (h < 48) return `${Math.floor(h)}h ${Math.round(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`;
}

/** Relative age like "5m ago" / "in 2h" against `now`. */
export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso);
  const diff = now - t;
  const txt = fmtAge(Math.abs(diff));
  return diff >= 0 ? `${txt} ago` : `in ${txt}`;
}

export function fmtAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(v);
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function humanize(s: string | null | undefined): string {
  if (!s) return '—';
  return s.replace(/_/g, ' ');
}

/**
 * An enum value as a sentence-case label: `VERIFIED_LIVE` → "Verified live", `company_capable` →
 * "Company capable". Only for API enum values (snake or screaming case), never for names.
 */
export function enumLabel(s: string | null | undefined): string {
  if (!s) return '—';
  const words = s.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Compact money for table cells: `£70k`, `$1.2M` (record pages keep the full amount). */
export function fmtMoneyCompact(v: number | null | undefined, currency: string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  try {
    return new Intl.NumberFormat('en-GB', {
      style: currency ? 'currency' : 'decimal',
      currency: currency ?? undefined,
      notation: 'compact',
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    })
      .format(v)
      .replace(/K$/, 'k');
  } catch {
    return `${currency ?? ''} ${v}`.trim();
  }
}

export function fmtMinutes(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  return fmtDuration(min * 60_000);
}

export function list(values: Array<string | null | undefined> | null | undefined, empty = '—'): string {
  const v = (values ?? []).filter((x): x is string => !!x);
  return v.length ? v.join(', ') : empty;
}

/** Compact, human-readable rendering of an arbitrary JSON-ish value. */
export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.length ? v.map((x) => fmtValue(x)).join(', ') : '(empty)';
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(
      ([, x]) => x !== null && x !== undefined && !(Array.isArray(x) && x.length === 0),
    );
    return entries.length ? entries.map(([k, x]) => `${k}: ${fmtValue(x)}`).join('; ') : '(empty)';
  }
  return String(v);
}

export function fmtLocation(
  l:
    | { text?: string; city?: string | null; region?: string | null; country?: string | null }
    | null
    | undefined,
): string {
  if (!l) return '—';
  const parts = [l.city, l.region, l.country].filter(Boolean);
  if (parts.length) return parts.join(', ');
  return l.text ?? '—';
}

export function fmtMoney(v: number | null | undefined, currency: string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  try {
    return new Intl.NumberFormat('en-GB', {
      style: currency ? 'currency' : 'decimal',
      currency: currency ?? undefined,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return `${fmtNum(v)} ${currency ?? ''}`.trim();
  }
}

/** First value of a search param (Next passes string | string[] | undefined). */
export function sp(v: string | string[] | undefined): string | undefined {
  const x = Array.isArray(v) ? v[0] : v;
  return x === undefined || x === '' ? undefined : x;
}

export function intParam(v: string | string[] | undefined, def: number, min = 0, max = 100_000): number {
  const n = Number.parseInt(sp(v) ?? '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
