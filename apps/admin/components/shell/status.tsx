import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { apiRequest } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { getApiHealth, HEALTH_LABEL, HEALTH_SHORT } from '@/lib/health';
import s from './Shell.module.css';

/**
 * Open review items waiting for an operator (the only sidebar count: calm, one small request).
 * Renders nothing on error or when the queue is empty, so the nav never breaks.
 */
export async function ReviewCount() {
  const res = await apiRequest<{ total: number }>('/api/review', {
    query: { status: 'open', limit: 1 },
    timeoutMs: 3000,
  });
  if (!res.ok || res.data.total === 0) return null;
  return (
    <span className={s.countAttention}>
      {fmtNum(res.data.total)}
      <span className="sr-only"> open</span>
    </span>
  );
}

/** Health dot next to "System status"; the state is also spelled out when it is not ready. */
export async function HealthDot() {
  const { state } = await getApiHealth();
  return (
    <span className={s.health} data-state={state} title={HEALTH_LABEL[state]}>
      <span className={s.healthDot} aria-hidden="true" />
      {state === 'ready' ? (
        <span className="sr-only">{HEALTH_LABEL[state]}</span>
      ) : (
        <span className={s.healthText}>
          {HEALTH_SHORT[state]}
          <span className="sr-only"> ({HEALTH_LABEL[state]})</span>
        </span>
      )}
    </span>
  );
}

/** One shell-level callout while the API is unavailable or not ready. */
export async function HealthNotice() {
  const health = await getApiHealth();
  if (health.state === 'ready') return null;
  return (
    <div className={s.notice} role="status">
      <strong>{HEALTH_LABEL[health.state]}</strong> at <code>{health.url}</code>: pages that need it will show
      errors. <Link href="/settings/system">System status</Link>
    </div>
  );
}

/** Always-visible security marker (ADR-0008): calm, but never hidden at any width. */
export function AuthChip() {
  return (
    <Link
      href="/settings/system#access"
      className={s.chip}
      title="Internal operations tool without authentication (ADR-0008). Do not expose publicly."
    >
      <Icon name="lock-open" size={14} />
      <span>Internal · no auth</span>
      <span className="sr-only">
        : internal operations tool without authentication, do not expose publicly
      </span>
    </Link>
  );
}
