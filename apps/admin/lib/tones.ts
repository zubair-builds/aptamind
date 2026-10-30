import type { StatusTone } from '@/components/ui/StatusPill';

/*
 * The one enum-value → tone map (design system §1). Presentation only: it colours values the API
 * returned and never derives a domain fact. Unmapped values stay neutral.
 */

const GENERIC: Record<string, StatusTone> = {
  // run / node states
  PENDING: 'neutral',
  QUEUED: 'neutral',
  RUNNING: 'info',
  FANNING_OUT: 'info',
  RETRY_SCHEDULED: 'warning',
  WAITING: 'warning',
  CANCELLING: 'warning',
  COMPLETED: 'success',
  FAILED: 'danger',
  SKIPPED: 'neutral',
  CANCELLED: 'neutral',
  // chunk states / attempts
  succeeded: 'success',
  completed: 'success',
  failed: 'danger',
  timed_out: 'danger',
  lost: 'danger',
  running: 'info',
  suspended: 'warning',
  cancelled: 'neutral',
  // import status (server-derived, market-imports.md)
  processing: 'info',
  completed_with_issues: 'warning',
  // job lifecycle
  DISCOVERED: 'info',
  VERIFIED_LIVE: 'success',
  CHANGED: 'accent',
  POSSIBLY_STALE: 'warning',
  CLOSED: 'neutral',
  REOPENED: 'info',
  REPOSTED: 'accent',
  // source health
  healthy: 'success',
  degraded: 'warning',
  failing: 'danger',
  never_run: 'neutral',
  // review queue state (server-computed queueState)
  resolving: 'info',
  // source freshness (server-computed freshnessState)
  fresh: 'success',
  due: 'info',
  overdue: 'warning',
  never_succeeded: 'warning',
  // review status
  // Review: an open item is the normal state (neutral); resolving/failed carry the colour.
  open: 'neutral',
  resolved: 'success',
  dismissed: 'neutral',
  // facts
  known: 'success',
  // Sources disagree: needs attention, not a failure (lower-authority alternates are neutral).
  conflicting: 'warning',
  // verification outcomes
  live: 'success',
  not_found: 'danger',
  inconclusive: 'warning',
  // sponsorship statuses
  explicit_yes: 'success',
  explicit_no: 'danger',
  company_capable: 'info',
  historical_evidence: 'warning',
  unclear: 'neutral',
  // licences
  listed: 'success',
  no_longer_listed: 'neutral',
  licensed: 'success',
  previously_licensed: 'warning',
  // observation resolution
  review: 'warning',
  rejected: 'neutral',
  // compensation
  parsed: 'success',
  ambiguous: 'warning',
  malformed: 'danger',
  // careers discovery
  found: 'success',
  website_unknown: 'warning',
  not_attempted: 'neutral',
  // misc
  active: 'success',
  merged: 'neutral',
  enabled: 'success',
  disabled: 'neutral',
};

const SEVERITY: Record<string, StatusTone> = {
  high: 'danger',
  medium: 'warning',
  warning: 'warning',
  low: 'neutral',
  info: 'neutral',
};
const CONFIDENCE: Record<string, StatusTone> = {
  high: 'success',
  medium: 'info',
  low: 'warning',
  unknown: 'neutral',
};

export type ToneKind = 'generic' | 'severity' | 'confidence';

export function toneFor(value: string | null | undefined, kind: ToneKind = 'generic'): StatusTone {
  if (!value) return 'neutral';
  if (kind === 'severity') return SEVERITY[value] ?? 'neutral';
  if (kind === 'confidence') return CONFIDENCE[value] ?? 'neutral';
  return GENERIC[value] ?? 'neutral';
}
