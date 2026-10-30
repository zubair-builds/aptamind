/** One hour: a server cannot park a host for longer than this through one header. */
export const DEFAULT_RETRY_AFTER_CAP_MS = 3_600_000;

// RFC 9110 § 10.2.3: delay-seconds or an HTTP-date. Date.parse alone also accepts "5.5" or
// "2020", so the date forms are matched first: IMF-fixdate, RFC 850 and asctime.
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC_850 = /^[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;

/**
 * Milliseconds to wait from a `Retry-After` value, capped at `capMs`. A date in the past gives 0.
 * Returns `undefined` for a missing or malformed value, so callers do not invent a delay.
 * Repeated headers arrive joined by commas; the longest valid wait wins.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number,
  capMs: number = DEFAULT_RETRY_AFTER_CAP_MS,
): number | undefined {
  const parts = (value ?? '').split(',').map((p) => p.trim());
  let best: number | undefined;
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i] as string;
    // HTTP-dates contain a comma after the weekday ("Thu, 01 Oct ..."): glue the two halves back.
    if (/^[A-Z][a-z]+$/.test(part) && i + 1 < parts.length) part = `${part}, ${parts[++i]}`;
    const ms = parseOne(part, nowMs, capMs);
    if (ms !== undefined && (best === undefined || ms > best)) best = ms;
  }
  return best;
}

function parseOne(v: string, nowMs: number, capMs: number): number | undefined {
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Math.min(Number(v) * 1000, capMs);
  let at: number;
  if (IMF_FIXDATE.test(v) || RFC_850.test(v)) at = Date.parse(v);
  // asctime has no zone; HTTP says it is GMT, but Date.parse would read it as local time.
  else if (ASCTIME.test(v)) at = Date.parse(`${v} GMT`);
  else return undefined;
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, at - nowMs), capMs);
}
