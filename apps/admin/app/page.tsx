import Link from 'next/link';
import { ApiErrorPanel } from '@/components/ApiError';
import { PageHeader, Section, Stat } from '@/components/Section';
import { Icon } from '@/components/ui/Icon';
import { apiGet } from '@/lib/api';
import { fmtAge, fmtNum, intParam } from '@/lib/format';
import type { Dashboard } from '@/lib/types';

const WINDOWS = [24, 72, 168] as const;
const QUEUE_LAG_WARN_MS = 5 * 60_000;
/** `/api/dashboard` counts jobs due verification up to this many (`jobsDueForVerification(1000)`). */
const DUE_VERIFICATION_CAP = 1000;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const requested = intParam(params.hours, 24, 1, 720);
  const hours = (WINDOWS as readonly number[]).includes(requested) ? requested : 24;
  const dash = await apiGet<Dashboard>('/api/dashboard', { hours });

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={<>Welcome back. Here's what's happening with your platform.</>}
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
      <p className="small muted">
        <Link href="/settings/system">Data quality and queues →</Link>
      </p>
    </>
  );
}

function DashboardBody({ d, hours }: { d: Dashboard; hours: number }) {
  const h = d.sources.byHealth;
  const failingCount = (h.failing ?? 0) + (h.degraded ?? 0);
  const runsFailed = d.runs.runsByState.FAILED ?? 0;
  const overdue = d.freshness.overdueSources;
  const due = d.freshness.jobsDueForVerification;
  const dueLabel = due >= DUE_VERIFICATION_CAP ? `${fmtNum(DUE_VERIFICATION_CAP)}+` : fmtNum(due);
  const laggingQueues = d.queues.filter((q) => (q.oldestWaitingAgeMs ?? 0) > QUEUE_LAG_WARN_MS);
  const windowLabel = hours === 168 ? '7d' : `${hours}h`;

  return (
    <>
      <div className="stats" role="list" aria-label="Key indicators">
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
            icon={<Icon name="inbox" />}
          />
        </div>
        <div role="listitem">
          <Stat
            label={`Runs (${windowLabel})`}
            value={<Link href="/runs?state=FAILED">{fmtNum(runsFailed)} failed</Link>}
            hint={`${fmtNum(d.runs.activeRuns)} active now`}
            tone={runsFailed ? 'bad' : 'ok'}
            icon={<Icon name="play" />}
          />
        </div>
        <div role="listitem">
          <Stat
            label="Source health"
            value={<Link href="/sources?health=failing">{fmtNum(failingCount)} failing or degraded</Link>}
            hint={`${fmtNum(overdue.length)} overdue`}
            tone={h.failing ? 'bad' : h.degraded || overdue.length ? 'warn' : 'ok'}
            icon={<Icon name="database" />}
          />
        </div>
        <div role="listitem">
          <Stat
            label={`This window (${windowLabel})`}
            value={
              <>
                <Link href="/companies">+{fmtNum(d.companies.created)} companies</Link>
                {' · '}
                <Link href="/jobs">+{fmtNum(d.jobs.created)} jobs</Link>
              </>
            }
            hint="created in window"
            icon={<Icon name="activity" />}
          />
        </div>
      </div>

      <Section title="What needs attention" id="next">
        <ul className="next-actions">
          {d.review.open > 0 ? (
            <li>
              <Link href="/review">
                <strong>{fmtNum(d.review.open)}</strong> open review{d.review.open === 1 ? '' : 's'}
              </Link>
              <span className="small muted">
                {d.review.oldestOpenAgeMs !== null
                  ? `oldest ${fmtAge(d.review.oldestOpenAgeMs)}`
                  : 'needs a decision'}
              </span>
            </li>
          ) : null}
          {overdue.length > 0 ? (
            <li>
              <Link href="/sources">
                <strong>{fmtNum(overdue.length)}</strong> source{overdue.length === 1 ? '' : 's'} past
                freshness
              </Link>
              <span className="small muted">check or reschedule</span>
            </li>
          ) : null}
          {failingCount > 0 ? (
            <li>
              <Link href="/sources">
                <strong>{fmtNum(failingCount)}</strong> source{failingCount === 1 ? '' : 's'} failing or
                degraded
              </Link>
              <span className="small muted">investigate last error</span>
            </li>
          ) : null}
          {due > 0 ? (
            <li>
              <Link href="/jobs">
                <strong>{dueLabel}</strong> job{due === 1 ? '' : 's'} due verification
              </Link>
              <span className="small muted">next check overdue</span>
            </li>
          ) : null}
          {runsFailed > 0 ? (
            <li>
              <Link href="/runs?state=FAILED">
                <strong>{fmtNum(runsFailed)}</strong> failed run{runsFailed === 1 ? '' : 's'} ({windowLabel})
              </Link>
              <span className="small muted">review and retry</span>
            </li>
          ) : null}
          {laggingQueues.length > 0 ? (
            <li>
              <span>
                <strong>{fmtNum(laggingQueues.length)}</strong> queue{laggingQueues.length === 1 ? '' : 's'}{' '}
                lagging
              </span>
              <span className="small muted">oldest waiting over 5m</span>
            </li>
          ) : null}
          {d.review.open === 0 &&
          overdue.length === 0 &&
          failingCount === 0 &&
          due === 0 &&
          runsFailed === 0 &&
          laggingQueues.length === 0 ? (
            <li className="muted">Nothing needs attention right now.</li>
          ) : null}
        </ul>
      </Section>
    </>
  );
}
