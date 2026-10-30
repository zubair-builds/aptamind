import type { ReactNode } from 'react';
import {
  ArtifactLink,
  ObservationLink,
  SnapshotLink,
  SourceLink,
  type SourceNames,
} from '@/components/links';
import { ConfidenceIndicator } from '@/components/ui/ConfidenceIndicator';
import { StatusPill } from '@/components/ui/StatusPill';
import { Time } from '@/components/ui/Time';
import { fmtValue, humanize } from '@/lib/format';
import type { Evidence, Fact } from '@/lib/types';
import { ExpandableQuote } from './ExpandableQuote';
import { FactPopover } from './FactPopover';
import { JumpLink } from './JumpLink';
import s from './facts.module.css';

/*
 * Canonical facts exactly as the API returns them (design system §13, contract
 * `market-provenance.md`). Nothing here derives or reinterprets a domain fact.
 *
 * - The primary label comes from `fact.status` only:
 *   `known` → the value; `unknown` → "Unknown"; `conflicting` → the value (or "No value") plus a
 *   warning "Sources disagree · N" button listing the disagreeing values; any other status (a
 *   domain state such as `expired`) → a neutral pill with that status — never shown as known.
 * - An Unknown (or unrecognised-status) fact that still carries a value keeps "Unknown" (or the
 *   status) as its label; the value appears as a secondary "Value on record: …" in the full view
 *   and in the provenance popover, never as the fact.
 * - A fact the API did not mark conflicting but that kept alternates (`conflicts[]`) shows a
 *   neutral "+N other values" popover.
 * - "N sources" opens the provenance popover (source → observation → artifact in two clicks).
 *   With no evidence it is plain text "No evidence", and the basis is shown inline instead.
 */

type Variant = 'full' | 'compact';

const STATUSES = new Set(['known', 'unknown', 'conflicting']);

/**
 * Operator-override evidence before M7.1 uses the literal `sourceId: 'operator'`, which is not a
 * source id: it is shown as "Operator" (linked to `operatorHref`, the record's overrides/audit
 * trail, when the page gives one). The M7.1 `system:operator` source is a real source and links.
 */
const isOperatorLiteral = (ev: Evidence) => ev.sourceId === 'operator';

/** A machine token (extractor@version) that may wrap only after `@` or `/`, never mid-part. */
function Token({ text }: { text: string }) {
  const parts = text.split(/(?<=[@/])/);
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className={s.token}>
          {p}
          {i < parts.length - 1 ? <wbr /> : null}
        </span>
      ))}
    </>
  );
}

function EvidenceItem({
  ev,
  sources,
  operatorHref,
}: {
  ev: Evidence;
  sources?: SourceNames;
  operatorHref?: string;
}) {
  return (
    <li className={s.evidence}>
      <div className={s.evidenceHead}>
        {isOperatorLiteral(ev) ? (
          operatorHref ? (
            <JumpLink href={operatorHref}>Operator override</JumpLink>
          ) : (
            <span>Operator</span>
          )
        ) : (
          <SourceLink id={ev.sourceId} names={sources} />
        )}
        {ev.authority ? <StatusPill tone="neutral">{humanize(ev.authority)}</StatusPill> : null}
        <span className={s.muted}>
          <Time value={ev.observedAt} />
        </span>
      </div>
      {ev.quote ? <ExpandableQuote quote={ev.quote} /> : null}
      {ev.locator ? <div className={s.locator}>{ev.locator}</div> : null}
      <div className={s.links}>
        {ev.observationId ? <ObservationLink id={ev.observationId}>Observation</ObservationLink> : null}
        {ev.snapshotId ? <SnapshotLink id={ev.snapshotId}>Snapshot</SnapshotLink> : null}
        {ev.artifactId ? (
          // Raw bytes only through the admin's text/plain + nosniff proxy, in a new tab.
          <ArtifactLink id={ev.artifactId}>
            Artifact<span className="sr-only"> (opens in a new tab)</span>
          </ArtifactLink>
        ) : null}
        {ev.extractor ? (
          <span className={s.muted}>
            via <Token text={`${ev.extractor.name}@${ev.extractor.version}`} />
          </span>
        ) : null}
      </div>
    </li>
  );
}

function EvidenceItems({
  evidence,
  sources,
  operatorHref,
}: {
  evidence: Evidence[];
  sources?: SourceNames;
  operatorHref?: string;
}) {
  if (!evidence.length) return <p className={s.muted}>No evidence recorded.</p>;
  return (
    <ul className={s.evidenceList}>
      {evidence.map((ev, i) => (
        <EvidenceItem
          key={`${ev.sourceId}-${ev.observationId ?? ''}-${i}`}
          ev={ev}
          sources={sources}
          operatorHref={operatorHref}
        />
      ))}
    </ul>
  );
}

/**
 * Whether a compact cell should show the confidence meter: only when it tells the reader something
 * beyond the value (low confidence, or a value whose confidence is unknown). An Unknown fact
 * already says so in words.
 */
export function flagsConfidence(fact: { status: string; confidence: { level: string } }) {
  const { level } = fact.confidence;
  return level === 'low' || (level === 'unknown' && fact.status !== 'unknown');
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function sourceCount(evidence: Evidence[]) {
  return new Set(evidence.map((e) => e.sourceId)).size;
}

/** Alternative values the API kept for a fact (`conflicts[]`), each with its reason and evidence. */
function Alternatives<T>({
  conflicts,
  renderValue,
  sources,
  operatorHref,
}: {
  conflicts: NonNullable<Fact<T>['conflicts']>;
  renderValue: (v: T | null) => ReactNode;
  sources?: SourceNames;
  operatorHref?: string;
}) {
  return (
    <ul className={s.alternatives}>
      {conflicts.map((c, i) => (
        <li key={i}>
          <div className={s.alternativeValue}>{renderValue(c.value)}</div>
          <div className={s.muted}>{c.reason}</div>
          <EvidenceItems evidence={c.evidence} sources={sources} operatorHref={operatorHref} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One fact as a property row: label | value (per status, see the header), confidence (bars and
 * word), provenance, and the disagreeing or other values the API kept.
 */
export function FactProperty<T>({
  label,
  fact,
  render,
  sources,
  note,
  variant = 'full',
  operatorHref,
}: {
  label: string;
  fact: Fact<T> | null | undefined;
  render?: (value: T) => ReactNode;
  sources?: SourceNames;
  note?: ReactNode;
  variant?: Variant;
  /** Where operator-override evidence links to (the record's overrides or audit section). */
  operatorHref?: string;
}) {
  if (!fact) {
    return (
      <div className={s.row}>
        <dt className={s.label}>{label}</dt>
        <dd className={s.value}>
          <span className={s.unknown}>Not in the API response</span>
        </dd>
      </div>
    );
  }
  const evidence = fact.evidence ?? [];
  const conflicts = fact.conflicts ?? [];
  const reasons = fact.confidence.reasons ?? [];
  const renderValue = (v: T | null): ReactNode =>
    v === null || v === undefined ? (
      <span className={s.unknown}>No value</span>
    ) : render ? (
      render(v)
    ) : (
      fmtValue(v)
    );
  const compact = variant === 'compact';
  const status = String(fact.status);
  const recognised = STATUSES.has(status);
  const isKnown = status === 'known';
  const isConflicting = status === 'conflicting';
  // Unknown or an unrecognised status: the value, if any, is secondary — never the fact.
  const valueOnRecord = !isKnown && !isConflicting && fact.value !== null && fact.value !== undefined;
  // An Unknown fact already says so in words; its "unknown" meter would only add noise.
  const showConfidence =
    (compact ? flagsConfidence(fact) : true) &&
    !(status === 'unknown' && fact.confidence.level === 'unknown');
  const sourcesN = sourceCount(evidence);
  // "No evidence" is already said next to the value; don't repeat it as a reason.
  const inlineReasons = (
    evidence.length ? reasons : reasons.filter((r) => !/^no evidence\b/i.test(r))
  ).filter(
    // The literal reason "none" means no basis was recorded: nothing to show inline.
    (r) => !/^none$/i.test(r.trim()),
  );
  // The basis is inline when there is no popover to hold it, and always for Unknown facts.
  const showBasisInline = !compact && inlineReasons.length > 0 && (status === 'unknown' || !evidence.length);

  const primary =
    status === 'unknown' ? (
      <span className={s.unknown} title={compact ? inlineReasons.join('; ') || undefined : undefined}>
        Unknown
        {compact && inlineReasons.length ? (
          <span className="sr-only"> (basis: {inlineReasons.join('; ')})</span>
        ) : null}
      </span>
    ) : !recognised ? (
      <StatusPill tone="neutral" title={`Status: ${status}`}>
        {humanize(status)}
      </StatusPill>
    ) : (
      renderValue(fact.value)
    );

  const provenance = evidence.length ? (
    <FactPopover label={`Provenance: ${label}`} text={plural(sourcesN, 'source')} srText={` for ${label}`}>
      <div className={s.panel}>
        <p className={s.panelTitle}>
          {label}: {plural(evidence.length, 'piece')} of evidence from {plural(sourcesN, 'source')}
        </p>
        {valueOnRecord ? (
          <p className={s.muted}>
            Status {humanize(status)} · value on record: {renderValue(fact.value)}
          </p>
        ) : null}
        <p className={s.muted}>
          Confidence {fact.confidence.level}
          {typeof fact.confidence.score === 'number' ? ` (${fact.confidence.score.toFixed(2)})` : ''}
          {reasons.filter((r) => !/^none$/i.test(r.trim())).length
            ? ` · basis: ${reasons.filter((r) => !/^none$/i.test(r.trim())).join('; ')}`
            : ' · no basis recorded'}
        </p>
        <EvidenceItems evidence={evidence} sources={sources} operatorHref={operatorHref} />
        {fact.policyVersion || fact.updatedAt ? (
          <p className={s.footer}>
            {fact.policyVersion ? `policy ${fact.policyVersion}` : null}
            {fact.policyVersion && fact.updatedAt ? ' · ' : null}
            {fact.updatedAt ? (
              <>
                updated <Time value={fact.updatedAt} />
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </FactPopover>
  ) : (
    <span className={s.noEvidence}>No evidence</span>
  );

  const alternatives = (
    <Alternatives
      conflicts={conflicts}
      renderValue={renderValue}
      sources={sources}
      operatorHref={operatorHref}
    />
  );

  return (
    <div className={s.row} data-status={status} data-variant={variant}>
      <dt className={s.label}>{label}</dt>
      <dd className={s.value}>
        <div className={s.line}>
          <span className={s.main}>{primary}</span>
          {isConflicting ? (
            conflicts.length ? (
              <FactPopover
                label={`Sources disagree: ${label}`}
                text={`Sources disagree · ${conflicts.length}`}
                srText={` on ${label}`}
                tone="warning"
              >
                <div className={s.panel}>
                  <p className={s.panelTitle}>Disagreeing values (the policy could not pick safely)</p>
                  {alternatives}
                </div>
              </FactPopover>
            ) : (
              <StatusPill tone="warning">Sources disagree</StatusPill>
            )
          ) : conflicts.length ? (
            <FactPopover
              label={`Other values: ${label}`}
              text={`+${plural(conflicts.length, 'other value')}`}
              srText={` for ${label}`}
            >
              <div className={s.panel}>
                <p className={s.panelTitle}>Other values (kept, not chosen)</p>
                {alternatives}
              </div>
            </FactPopover>
          ) : null}
          {showConfidence ? (
            <ConfidenceIndicator level={fact.confidence.level} score={fact.confidence.score} showLabel />
          ) : null}
          {provenance}
        </div>
        {!compact && valueOnRecord ? (
          <div className={s.reason}>Value on record: {renderValue(fact.value)}</div>
        ) : null}
        {showBasisInline ? <div className={s.reason}>Basis: {inlineReasons.join('; ')}</div> : null}
        {note && !compact ? <div className={s.reason}>{note}</div> : null}
      </dd>
    </div>
  );
}

/** A group of fact rows (a definition list). */
export function FactGroup({ children }: { children: ReactNode }) {
  return <dl className={s.group}>{children}</dl>;
}
