import type { ReactNode } from 'react';
import { ConfidenceIndicator } from '@/components/ui/ConfidenceIndicator';
import { StatusPill } from '@/components/ui/StatusPill';
import { fmtValue, humanize } from '@/lib/format';
import type { SummaryFact } from '@/lib/types';
import { flagsConfidence, plural } from './FactProperty';
import s from './facts.module.css';

/** A v1 full `Fact` also fits: it has `conflicts[]` instead of `alternates`. */
type SummaryInput<T> = SummaryFact<T> & { conflicts?: unknown[] };

/**
 * A fact in a table cell or peek panel: the value as returned, the fact's own status and, when
 * they add something, low confidence, the decision `basis` and the number of alternates. It takes
 * a `SummaryFact` (Market API v2) or a v1 `Fact`: without `alternates` the count is the length of
 * `conflicts[]` (the same number the v2 API sends); without `basis` none is shown. Provenance
 * lives on the record page (`FactProperty`). Status labels match `FactProperty`: "Unknown",
 * "Sources disagree", a neutral pill for any other status (never shown as known).
 */
export function FactSummary<T>({
  fact,
  render,
}: {
  fact: SummaryInput<T> | null | undefined;
  render?: (value: T) => ReactNode;
}) {
  if (!fact) return <span className={s.unknown}>—</span>;
  const status = String(fact.status);
  // A recorded basis of "none" means no basis (same rule as FactProperty).
  const basis =
    typeof fact.basis === 'string' && fact.basis && !/^none$/i.test(fact.basis.trim()) ? fact.basis : null;
  const alternates =
    typeof fact.alternates === 'number'
      ? fact.alternates
      : Array.isArray(fact.conflicts)
        ? fact.conflicts.length
        : 0;
  const value =
    status === 'unknown' ? (
      <span className={s.unknown}>Unknown</span>
    ) : status !== 'known' && status !== 'conflicting' ? (
      <StatusPill tone="neutral" title={`Status: ${status}`}>
        {humanize(status)}
      </StatusPill>
    ) : fact.value === null || fact.value === undefined ? (
      <span className={s.unknown}>No value</span>
    ) : render ? (
      render(fact.value)
    ) : (
      fmtValue(fact.value)
    );
  return (
    <span className={s.summary} data-status={status} title={basis ? `Basis: ${basis}` : undefined}>
      <span className={s.main}>{value}</span>
      {status === 'conflicting' ? <StatusPill tone="warning">Sources disagree</StatusPill> : null}
      {status !== 'conflicting' && alternates > 0 ? (
        <span className={s.alternatesHint}>
          +{alternates}
          <span className="sr-only"> ({plural(alternates, 'other value')} kept)</span>
        </span>
      ) : null}
      {flagsConfidence(fact) ? (
        <ConfidenceIndicator level={fact.confidence.level} score={fact.confidence.score} showLabel />
      ) : null}
      {basis ? <span className="sr-only">. Basis: {basis}</span> : null}
    </span>
  );
}
