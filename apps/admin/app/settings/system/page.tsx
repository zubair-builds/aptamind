import { ApiErrorPanel } from '@/components/ApiError';
import { DataTable } from '@/components/DataTable';
import { Distribution } from '@/components/Distribution';
import { PageHeader, Section, Stat } from '@/components/Section';
import { PropertyList } from '@/components/ui/PropertyList';
import { StatusPill } from '@/components/ui/StatusPill';
import { apiGet } from '@/lib/api';
import { fmtAge, fmtDuration, fmtNum, fmtPct, humanize, intParam } from '@/lib/format';
import { getApiHealth, HEALTH_LABEL } from '@/lib/health';
import type { DataQuality, QueueCounts } from '@/lib/types';

export const metadata = { title: 'System status' };

const TONE = { ready: 'success', not_ready: 'warning', unavailable: 'danger' } as const;
const QUEUE_LAG_WARN_MS = 5 * 60_000;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SystemPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  // Data-quality window in days (moved from the Overview, which derived it from its 24h/72h/7d tabs).
  const days = intParam(params.days, 1, 1, 30);
  const [health, dq, queues] = await Promise.all([
    getApiHealth(),
    apiGet<DataQuality>('/api/metrics/data-quality', { days }),
    apiGet<{ items: QueueCounts[] }>('/api/metrics/queues'),
  ]);
  return (
    <>
      <PageHeader title="System status" subtitle="Connection from this admin to the internal API." />
      <Section title="Internal API" id="api">
        <PropertyList
          items={[
            {
              label: 'Status',
              value: <StatusPill tone={TONE[health.state]}>{HEALTH_LABEL[health.state]}</StatusPill>,
            },
            { label: 'Base URL', value: <code>{health.url}</code> },
            health.message ? { label: 'Last error', value: health.message } : null,
          ]}
        />
        {health.checks ? (
          <div className="table-wrap" role="region" aria-label="Readiness checks" tabIndex={0}>
            <table className="table">
              <caption className="sr-only">Readiness checks</caption>
              <thead>
                <tr>
                  <th scope="col">Dependency</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(health.checks).map(([name, ok]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>
                      <StatusPill tone={ok ? 'success' : 'danger'}>{ok ? 'ready' : 'not ready'}</StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Section>
      <Section title="Access" id="access">
        <p>
          Internal operations tool. When <code>ADMIN_PASSWORD</code> is set, every page and every{' '}
          <code>/api</code> route require HTTP basic auth (any username, the shared password); only{' '}
          <code>/health</code> stays public. There are no per-user accounts: every signed-in visitor acts as
          the internal operator. Without <code>ADMIN_PASSWORD</code> the admin is open, so keep it on a
          private interface.
        </p>
      </Section>
      {queues.ok ? (
        <QueuesSection rows={queues.data.items} />
      ) : (
        <ApiErrorPanel error={queues.error} title="Queue metrics unavailable" />
      )}
      {dq.ok ? (
        <DataQualitySection q={dq.data} days={days} />
      ) : (
        <ApiErrorPanel error={dq.error} title="Data-quality metrics unavailable" />
      )}
    </>
  );
}

function QueuesSection({ rows }: { rows: QueueCounts[] }) {
  return (
    <Section
      title="Queues"
      id="queues"
      description="Transport queues (BullMQ). Rows are highlighted when the oldest waiting job is older than 5 minutes."
    >
      <DataTable<QueueCounts>
        caption="Queues"
        rows={rows}
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
