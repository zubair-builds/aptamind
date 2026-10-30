/**
 * Timestamp labels (design system §4). Calendar maths is in UTC and month/day names are fixed
 * (not ICU-dependent), so server and client render the same text.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');
const dayMonth = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

/** "just now", "3m ago", "5h ago", "Tue", "12 Sep", "12 Sep 2025"; future "in 3m", "in 3h", "in 2d". */
export function relativeLabel(date: Date, now: Date): string {
  const diff = now.getTime() - date.getTime();
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'just now';
  if (diff < 0) {
    if (abs < HOUR) return `in ${Math.round(abs / MIN)}m`;
    if (abs < DAY) return `in ${Math.round(abs / HOUR)}h`;
    return `in ${Math.round(abs / DAY)}d`;
  }
  if (abs < HOUR) return `${Math.max(1, Math.round(abs / MIN))}m ago`;
  if (abs < DAY) return `${Math.round(abs / HOUR)}h ago`;
  if (abs < 7 * DAY) return WEEKDAYS[date.getUTCDay()]!;
  if (date.getUTCFullYear() === now.getUTCFullYear()) return dayMonth(date);
  return `${dayMonth(date)} ${date.getUTCFullYear()}`;
}

/** "12 Sep 2026, 14:03 UTC". */
export function absoluteLabel(date: Date): string {
  return `${dayMonth(date)} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
