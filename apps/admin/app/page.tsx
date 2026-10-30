import Link from 'next/link';
import { ApiErrorPanel } from '@/components/ApiError';
import { StatusBadge } from '@/components/Badge';
import { DataTable } from '@/components/DataTable';
import { Distribution } from '@/components/Distribution';
import { SourceLink } from '@/components/links';
import { PageHeader, Section, Stat } from '@/components/Section';
import { RelTime } from '@/components/Time';
import { apiGet } from '@/lib/api';
import { fmtAge, fmtDuration, fmtNum, fmtPct, humanize, intParam } from '@/lib/format';
import type { Dashboard, DataQuality, QueueCounts } from '@/lib/types';

const WINDOWS = [24, 72, 168] as const;
const QUEUE_LAG_WARN_MS = 5 * 60_000;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const requested = intParam(params.hours, 24, 1, 720);
  const hours = (WINDOWS as readonly number[]).includes(requested) ? requested : 24;
  const days = Math.max(1, Math.round(hours / 24));
  const [dash, dq] = await Promise.all([
    apiGet<Dashboard>('/api/dashboard', { hours }),
    apiGet<DataQuality>('/api/metrics/data-quality', { days }),
  ]);

  return (
    <>
      <PageHeader
        title="Home"
        subtitle={<>Source health, failures, changes, staleness, review backlog and queue pressure.</>}
        actions={
          <nav className="tabs" aria-label="Time window">
            {WINDOWS.map((h) => (
              <Link key={h} href={`/?hours=${h}`} aria-current={h === hours ? 'page' : undefined}>
                {h === 168 ? '7 days' : `${h}h`}
              </Link>
            ))}
          </nav>
        }
      />
      {dash.ok ? <DashboardBody d={dash.data} hours={hours} /> : <ApiErrorPanel error={dash.error} />}
      {dq.ok ? (
        <DataQualitySection q={dq.data} days={days} />
      ) : dash.ok ? (
        <ApiErrorPanel error={dq.error} title="Data-quality metrics unavailable" />
      ) : null}
    </>
  );
}

function DashboardBody({ d, hours }: { d: Dashboard; hours: number }) {
  const h = d.sources.byHealth;
  const failingCount = (h.failing ?? 0) + (h.degraded ?? 0);
  const runsFailed = d.runs.runsByState.FAILED ?? 0;
  const overdue = d.freshness.overdueSources;
  const queueBacklog = d.queues.reduce((a, q) => a + q.waiting + q.delayed, 0);
  const laggingQueues = d.queues.filter((q) => (q.oldestWaitingAgeMs ?? 0) > QUEUE_LAG_WARN_MS);
  const windowLabel = hours === 168 ? '7d' : `${hours}h`;

  return (
    <>
      <div className="stats" role="list" aria-label="Key indicators">
        <div role="listitem">
          <Stat
            label="Sources healthy"
            value={fmtNum(h.healthy ?? 0)}
            hint={failingCount ? `${h.failing ?? 0} failing · ${h.degraded ?? 0} degraded` : 'none failing'}
            tone={h.failing ? 'bad' : h.degraded ? 'warn' : 'ok'}
          />
        </div>
        <div role="listitem">
          <Stat
            label="Overdue sources"
            value={fmtNum(overdue.length)}
            hint="past freshness policy"
            tone={overdue.length ? 'warn' : 'ok'}
          />
        </div>
        <div role="listitem">
          <Stat
            label={`Runs failed (${windowLabel})`}
            value={fmtNum(runsFailed)}
            hint={`${fmtNum(d.runs.activeRuns)} active now`}
            tone={runsFailed ? 'bad' : 'ok'}
          />
        </div>
        <div role="listitem">
          <Stat
            label="Queue backlog"
            value={fmtNum(queueBacklog)}
            hint={
              laggingQueues.length
                ? `${laggingQueues.length} queue(s) lagging > 5m`
                : `oldest node queued ${fmtAge(d.runs.oldestQueuedAgeMs)}`
            }
            tone={laggingQueues.length ? 'warn' : undefined}
          />
        </div>
        <div role="listitem">
          <Stat
            label="Open reviews"
            value={<Link href="/review">{fmtNum(d.review.open)}</Link>}
            hint={
              d.review.oldestOpenAgeMs !== null
                ? `oldest ${fmtAge(d.review.oldestOpenAgeMs)}`
                : 'backlog empty'
            }
            tone={d.review.open ? 'warn' : 'ok'}
          />
        </div>
        <div role="listitem">
          <Stat
            label="Jobs due verification"
            value={fmtNum(d.freshness.jobsDueForVerification)}
            hint="next check overdue"
            tone={d.freshness.jobsDueForVerification ? 'warn' : 'ok'}
          />
        </div>
        <div role="listitem">
          <Stat
            label={`Companies (${windowLabel})`}
            value={`+${fmtNum(d.companies.created)}`}
            hint={`${fmtNum(d.companies.changed)} changed · ${fmtNum(d.companies.total)} total`}
          />
        </div>
        <div role="listitem">
          <Stat
            label={`Jobs (${windowLabel})`}
            value={`+${fmtNum(d.jobs.created)}`}
            hint={`${fmtNum(d.jobs.changed)} changed · ${fmtNum(d.jobs.closed)} closed`}
          />
        </div>
      </div>

      <div className="grid-2">
        <Section title="Failing / degraded sources" id="failing">
          <DataTable
            caption="Failing sources"
            rows={d.sources.failing}
            rowKey={(r) => r._id}
            empty="All sources healthy."
            columns={[
              {
                key: 'name',
                header: 'Source',
                cell: (r) => <SourceLink id={r._id}>{r.name ?? r.key}</SourceLink>,
              },
              { key: 'status', header: 'Health', cell: (r) => <StatusBadge value={r.health.status} /> },
              {
                key: 'cf',
                header: 'Consec. failures',
                numeric: true,
                cell: (r) => r.health.consecutiveFailures,
              },
              { key: 'last', header: 'Last failure', cell: (r) => <RelTime iso={r.health.lastFailureAt} /> },
              {
                key: 'err',
                header: 'Last error',
                className: 'error-cell',
                cell: (r) => <span className="text-bad small">{r.health.lastError ?? '—'}</span>,
              },
            ]}
          />
        </Section>
        <Section title="Stale sources (freshness overdue)" id="overdue">
          <DataTable
            caption="Overdue sources"
            rows={overdue}
            rowKey={(r) => r.sourceId}
            empty="No source is past its freshness policy."
            columns={[
              {
                key: 'name',
                header: 'Source',
                cell: (r) => <SourceLink id={r.sourceId}>{r.name}</SourceLink>,
              },
              { key: 'status', header: 'Health', cell: (r) => <StatusBadge value={r.status} /> },
              {
                key: 'age',
                header: 'Since last success',
                numeric: true,
                cell: (r) => (r.ageMs === null ? <span className="text-warn">never</span> : fmtAge(r.ageMs)),
              },
              { key: 'max', header: 'Max age', numeric: true, cell: (r) => fmtAge(r.maxAgeMs) },
            ]}
          />
        </Section>
      </div>

      <div className="grid-2">
        <Section
          title={`Workflow runs (${windowLabel}, top-level)`}
          id="runs"
          actions={
            <Link href="/runs?state=FAILED" className="small">
              View failed runs →
            </Link>
          }
        >
          <div className="grid-2">
            <Distribution title="Runs by state" counts={d.runs.runsByState} emptyLabel="No runs in window." />
            <Distribution
              title="Node failures by capability"
              counts={d.runs.nodeFailuresByCapability}
              emptyLabel="No node failures."
            />
          </div>
          <p className="small muted">
            Waiting nodes: <strong>{fmtNum(d.runs.waitingNodes)}</strong> · retry scheduled:{' '}
            <strong>{fmtNum(d.runs.retryScheduledNodes)}</strong> · oldest queued node:{' '}
            <strong>{fmtDuration(d.runs.oldestQueuedAgeMs)}</strong> · mean attempts/node:{' '}
            <strong>{fmtNum(d.runs.meanAttemptsPerNode)}</strong>
          </p>
        </Section>
        <Section
          title="Queues"
          id="queues"
          description="Transport queues (BullMQ). Rows are highlighted when the oldest waiting job is older than 5 minutes."
        >
          <DataTable<QueueCounts>
            caption="Queues"
            rows={d.queues}
            rowKey={(r) => r.queue}
            rowClassName={(r) => ((r.oldestWaitingAgeMs ?? 0) > QUEUE_LAG_WARN_MS ? 'row-warn' : undefined)}
            columns={[
              { key: 'q', header: 'Queue', cell: (r) => <code>{r.queue}</code> },
              { key: 'w', header: 'Waiting', numeric: true, cell: (r) => fmtNum(r.waiting) },
              { key: 'a', header: 'Active', numeric: true, cell: (r) => fmtNum(r.active) },
              { key: 'd', header: 'Delayed', numeric: true, cell: (r) => fmtNum(r.delayed) },
              {
                key: 'f',
                header: 'Failed',
                numeric: true,
                cell: (r) => (r.failed ? <span className="text-bad">{fmtNum(r.failed)}</span> : '0'),
              },
              { key: 'p', header: 'Paused', numeric: true, cell: (r) => fmtNum(r.paused) },
              {
                key: 'o',
                header: 'Oldest waiting',
                numeric: true,
                cell: (r) => fmtAge(r.oldestWaitingAgeMs),
              },
            ]}
          />
        </Section>
      </div>

      <div className="grid-3">
        <Section title="Jobs by lifecycle state" id="jobs">
          <Distribution title="Active jobs" counts={d.jobs.byState} emptyLabel="No jobs yet." />
          <p className="small">
            <Link href="/jobs?state=POSSIBLY_STALE">Possibly stale jobs →</Link>
          </p>
        </Section>
        <Section title="Review backlog" id="review">
          <Distribution
            title="Open items by type"
            counts={d.review.openByType}
            emptyLabel="Nothing needs review."
          />
          <p className="small">
            <Link href="/review">Open the review queue →</Link>
          </p>
        </Section>
        <Section title="Source health" id="health">
          <Distribution
            title="Sources by health"
            counts={d.sources.byHealth}
            emptyLabel="No sources registered."
          />
          <p className="small">
            <Link href="/sources?health=failing">Failing sources →</Link>
          </p>
        </Section>
      </div>
    </>
  );
}

function DataQualitySection({ q, days }: { q: DataQuality; days: number }) {
  const e = q.entityQuality;
  const j = q.jobQuality;
  return (
    <Section
      title={`Data quality (${days}d window)`}
      id="data-quality"
      description="GET /api/metrics/data-quality — resolution, duplicates, freshness and interpretation coverage."
    >
      <div className="stats">
        <Stat
          label="Unresolved company obs."
          value={fmtPct(e.unresolvedCompanyRate)}
          tone={(e.unresolvedCompanyRate ?? 0) > 0.05 ? 'warn' : undefined}
        />
        <Stat
          label="Duplicate company rate"
          value={fmtPct(e.duplicateCompanyRate)}
          hint={`${fmtNum(e.mergedCompanies)} merged`}
        />
        <Stat label="Obs → canonical lag" value={fmtDuration(e.observationToCanonicalLagMs)} />
        <Stat label="Verified-live rate" value={fmtPct(j.verifiedLiveRate)} />
        <Stat
          label="Stale rate"
          value={fmtPct(j.staleRate)}
          tone={(j.staleRate ?? 0) > 0.1 ? 'warn' : undefined}
        />
        <Stat
          label="Review correction rate"
          value={fmtPct(q.review.correctionRate)}
          hint="correct/merge/create_new share"
        />
      </div>
      <div className="grid-3">
        <Distribution title="Company observation resolution" counts={e.companyObservationResolution} />
        <Distribution title="Job observation resolution" counts={e.jobObservationResolution} />
        <Distribution title="Verification outcomes" counts={j.verificationsByOutcome} />
        <Distribution title="Work model" counts={q.intelligence.workModel} />
        <Distribution title="Remote scope" counts={q.intelligence.remoteScope} />
        <Distribution title="Sponsorship status" counts={q.intelligence.sponsorship} />
        <Distribution title="Salary parse status" counts={q.intelligence.salaryStatus} />
        <Distribution title="Work-model confidence" counts={q.intelligence.workModelConfidence} />
        <Distribution title="Review decisions" counts={q.review.decisionsByAction} />
      </div>
      {Object.keys(e.duplicateReviews).length ? (
        <p className="small muted">
          Duplicate reviews (all time):{' '}
          {Object.entries(e.duplicateReviews)
            .map(([k, v]) => `${humanize(k)} ${v}`)
            .join(' · ')}
        </p>
      ) : null}
    </Section>
  );
}
