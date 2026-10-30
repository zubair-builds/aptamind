import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { sourceNames } from '@/components/links';
import { PageHeader } from '@/components/Section';
import { FactGroup, FactProperty } from '@/components/records/facts/FactProperty';
import { FactSummary } from '@/components/records/facts/FactSummary';
import { Button, ButtonLink, IconButton } from '@/components/ui/Button';
import { ConfidenceIndicator } from '@/components/ui/ConfidenceIndicator';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Kbd } from '@/components/ui/Kbd';
import { PropertyList } from '@/components/ui/PropertyList';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { StatusPill, type StatusTone } from '@/components/ui/StatusPill';
import { Time } from '@/components/ui/Time';
import type { Evidence, Fact, SummaryFact } from '@/lib/types';
import s from './catalogue.module.css';
import { DialogDemo, MenuDemo, PendingDemo, PopoverDemo, TabsDemo, ToastDemo, TooltipDemo } from './demos';

export const metadata = { title: 'UI catalogue' };

const TONES: StatusTone[] = ['neutral', 'info', 'success', 'warning', 'danger', 'accent'];
const NOW = new Date('2026-09-29T12:00:00Z');

// No demo records exist, so demo evidence carries no source/observation/snapshot/artifact ids
// (their links would 404): it is operator evidence, linked to this section.
const EV: Evidence = {
  sourceId: 'operator',
  locator: 'jobs_demo#description[120:168]',
  quote:
    'This role is fully remote within the EU. You can work from any EU member state; we meet in person twice a year in Lisbon and cover travel.',
  observedAt: '2026-09-28T09:00:00Z',
  authority: 'official_ats',
  extractor: { name: 'workmodel.rules', version: '3' },
};
const DEMO_SOURCES = sourceNames([]);
const demoFact = (over: Partial<Fact<string>>): Fact<string> => ({
  value: 'remote',
  status: 'known',
  confidence: { level: 'high', score: 0.92, reasons: ['description.explicit'] },
  evidence: [EV],
  conflicts: [],
  policyVersion: 'job-policy/1',
  updatedAt: '2026-09-28T09:05:00Z',
  ...over,
});
const FACT_STATES: Array<[string, Fact<string>]> = [
  ['Known', demoFact({})],
  [
    'Other values',
    demoFact({
      conflicts: [
        {
          value: 'hybrid',
          reason: 'lower authority (third party)',
          evidence: [{ ...EV, quote: 'Hybrid, 2 days in the office', authority: 'third_party' }],
        },
      ],
    }),
  ],
  [
    'Conflicting',
    demoFact({
      status: 'conflicting',
      confidence: { level: 'low', reasons: ['equal authority sources disagree'] },
      conflicts: [
        {
          value: 'onsite',
          reason: 'official site says onsite',
          evidence: [{ ...EV, authority: 'official_site' }],
        },
      ],
    }),
  ],
  [
    'Unknown',
    demoFact({
      value: null,
      status: 'unknown',
      confidence: { level: 'unknown', reasons: ['no work model statement'] },
    }),
  ],
  [
    'Unknown, value on record',
    demoFact({
      value: 'onsite',
      status: 'unknown',
      confidence: { level: 'unknown', reasons: ['stale listing'] },
    }),
  ],
  [
    'Other status',
    demoFact({
      status: 'expired' as Fact<string>['status'],
      confidence: { level: 'medium', reasons: ['listing closed'] },
    }),
  ],
  [
    'No evidence',
    demoFact({
      value: 'onsite',
      confidence: { level: 'medium', reasons: ['operator default'] },
      evidence: [],
    }),
  ],
];

const SUMMARY_STATES: Array<[string, SummaryFact<string>]> = [
  ['Known (API v1)', { value: 'remote', status: 'known', confidence: { level: 'high' } }],
  [
    'Basis and alternates',
    {
      value: 'remote',
      status: 'known',
      confidence: { level: 'high' },
      basis: 'provider.workplaceType',
      alternates: 1,
    },
  ],
  [
    'Sources disagree',
    { value: 'hybrid', status: 'conflicting', confidence: { level: 'low' }, alternates: 1 },
  ],
  ['Unknown', { value: null, status: 'unknown', confidence: { level: 'unknown' } }],
];

function Demo({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  const id = `ui-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section className={s.demo} aria-labelledby={id}>
      <h2 id={id} className={s.title}>
        {title}
      </h2>
      {note ? <p className={s.note}>{note}</p> : null}
      <div className={s.row}>{children}</div>
    </section>
  );
}

/**
 * Design-system primitives (docs/design/admin-design-system.md). Development only: in production
 * builds it exists only when ADMIN_UI_CATALOGUE=1 (the e2e accessibility checks use it).
 */
export default function UiCataloguePage() {
  if (process.env.NODE_ENV === 'production' && process.env.ADMIN_UI_CATALOGUE !== '1') notFound();
  return (
    <>
      <PageHeader
        title="UI catalogue"
        subtitle="Primitives in components/ui, rendered with semantic tokens."
      />
      <div className={s.grid}>
        <Demo title="Buttons">
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button size="sm" icon="rotate-cw">
            Small with icon
          </Button>
          <Button disabled>Disabled</Button>
          <PendingDemo />
          <ButtonLink href="/sources/new" variant="primary">
            New source
          </ButtonLink>
          <IconButton label="Copy link" icon="copy" />
        </Demo>
        <Demo title="Status pills" note="Dot plus text: colour is never the only signal.">
          {TONES.map((t) => (
            <StatusPill key={t} tone={t}>
              {t}
            </StatusPill>
          ))}
        </Demo>
        <Demo title="Keyboard hints">
          <Kbd>⌘K</Kbd>
          <span>
            <Kbd>g</Kbd> then <Kbd>j</Kbd>
          </span>
          <Kbd>Esc</Kbd>
        </Demo>
        <Demo title="Tooltip" note="Hover (short delay) or keyboard focus; Escape hides it.">
          <TooltipDemo />
        </Demo>
        <Demo title="Popover">
          <PopoverDemo />
        </Demo>
        <Demo title="Menu" note="Arrow keys, Home/End, type-ahead, Escape returns focus.">
          <MenuDemo />
        </Demo>
        <Demo title="Dialog">
          <DialogDemo />
        </Demo>
        <Demo title="Toast">
          <ToastDemo />
        </Demo>
        <Demo title="Tabs">
          <div className={s.wide}>
            <TabsDemo />
          </div>
        </Demo>
        <Demo title="Property list">
          <div className={s.wide}>
            <PropertyList
              title="Work model & location"
              items={[
                { label: 'Work model', value: <StatusPill tone="success">remote</StatusPill> },
                { label: 'Remote scope', value: 'Region (EMEA)' },
                { label: 'Listed location', value: 'Remote - EMEA' },
                { label: 'Visa sponsorship', value: null },
              ]}
            />
          </div>
        </Demo>
        <Demo title="Confidence" note="Level (and score when the API has one) is the accessible name.">
          <ConfidenceIndicator level="high" score={0.92} showLabel />
          <ConfidenceIndicator level="medium" showLabel />
          <ConfidenceIndicator level="low" score={0.31} showLabel />
          <ConfidenceIndicator level="unknown" showLabel />
        </Demo>
        <Demo
          title="Facts"
          note="components/records/facts: status only from the API; the sources button opens provenance."
        >
          <div className={s.wide}>
            <FactGroup>
              {FACT_STATES.map(([name, f]) => (
                <FactProperty
                  key={name}
                  label={name}
                  fact={f}
                  sources={DEMO_SOURCES}
                  operatorHref="#ui-facts"
                />
              ))}
            </FactGroup>
          </div>
        </Demo>
        <Demo
          title="Fact summaries"
          note="Table cells and peek: basis and alternates when the API sends them."
        >
          <dl className={s.summaryList}>
            {SUMMARY_STATES.map(([name, f]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>
                  <FactSummary fact={f} />
                </dd>
              </div>
            ))}
          </dl>
        </Demo>
        <Demo title="Time" note="Relative in lists, absolute UTC on record pages; tooltip adds local time.">
          <Time value="2026-09-29T11:57:00Z" now={NOW} />
          <Time value="2026-09-29T07:00:00Z" now={NOW} />
          <Time value="2026-09-26T09:00:00Z" now={NOW} />
          <Time value="2025-09-12T14:03:00Z" now={NOW} />
          <Time value="2026-09-29T15:00:00Z" now={NOW} />
          <Time value="2026-09-12T14:03:00Z" mode="absolute" now={NOW} />
        </Demo>
        <Demo title="Copy button">
          <code>job_01M3PM8C1XA8CYDM51KQEACXN6</code>
          <CopyButton value="job_01M3PM8C1XA8CYDM51KQEACXN6" label="Copy id" />
        </Demo>
        <Demo title="Skeleton">
          <div className={s.wide}>
            <Skeleton width="40%" height={16} />
            <SkeletonRows rows={3} />
          </div>
        </Demo>
        <Demo title="Empty state">
          <EmptyState
            title="No sources yet."
            description="Register an information origin to start collecting evidence."
            action={
              <ButtonLink href="/sources/new" variant="primary" size="sm">
                New source
              </ButtonLink>
            }
          />
        </Demo>
        <Demo
          title="Error state"
          note="Wraps API failures (ApiErrorPanel) with code, status, request id and retry."
        >
          <div className={s.wide}>
            <ErrorState
              title="API error"
              message={
                <>
                  <code>not_found</code> (HTTP 404): Job job_123 was not found.
                </>
              }
              meta="GET /api/jobs/job_123 — request req_8f2c"
              details={'{\n  "id": "job_123"\n}'}
              retry={false}
              announce={false}
            />
          </div>
        </Demo>
      </div>
    </>
  );
}
