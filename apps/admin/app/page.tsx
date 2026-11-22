import Link from 'next/link';
import type { ReactNode } from 'react';
import { ApiErrorPanel } from '@/components/ApiError';
import { PageHeader } from '@/components/Section';
import { apiGet } from '@/lib/api';
import { fmtAge, fmtNum, intParam } from '@/lib/format';
import type { Dashboard } from '@/lib/types';
import styles from './overview.module.css';

const WINDOWS = [24, 72, 168] as const;
const QUEUE_LAG_WARN_MS = 5 * 60_000;
/** `/api/dashboard` counts jobs due verification up to this many (`jobsDueForVerification(1000)`). */
const DUE_VERIFICATION_CAP = 1000;
/** The Source health card counts both, so its link filters both (the sources API accepts repeats). */
const SOURCES_UNHEALTHY_HREF = '/sources?health=failing&health=degraded';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type CardTone = 'info' | 'warning' | 'danger' | 'success';

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const requested = intParam(params.hours, 24, 1, 720);
  const hours = (WINDOWS as readonly number[]).includes(requested) ? requested : 24;
  const dash = await apiGet<Dashboard>('/api/dashboard', { hours });

  return (
    <div className={styles.page}>
      <PageHeader
        title="Overview"
        subtitle={<>What needs your attention in the last {windowText(hours)}.</>}
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
      <p className={styles.more}>
        <Link href="/settings/system">Data quality and queues →</Link>
      </p>
    </div>
  );
}

function windowText(hours: number) {
  return hours === 168 ? '7 days' : `${hours} hours`;
}

function InsightCard({ label, tone, children }: { label: ReactNode; tone: CardTone; children: ReactNode }) {
  return (
    <li className={`${styles.card} ${styles[tone]}`}>
      <div className={styles.label}>{label}</div>
      <div className={styles.metrics}>{children}</div>
    </li>
  );
}

function Metric({ value, hint, href }: { value: ReactNode; hint: ReactNode; href?: string }) {
  return (
    <div className={styles.metric}>
      {href ? (
        <Link href={href} className={styles.value}>
          {value}
        </Link>
      ) : (
        <span className={styles.value}>{value}</span>
      )}
      <span className={styles.hint}>{hint}</span>
    </div>
  );
}

function AttentionRow({ href, children, meta }: { href?: string; children: ReactNode; meta: ReactNode }) {
  return (
    <li className={styles.row}>
      {href ? (
        <Link href={href} className={styles.rowTitle}>
          {children}
        </Link>
      ) : (
        <span className={styles.rowTitle}>{children}</span>
      )}
      <span className={styles.rowMeta}>{meta}</span>
    </li>
  );
}

function DashboardBody({ d, hours }: { d: Dashboard; hours: number }) {
  const h = d.sources.byHealth;
  const failingCount = (h.failing ?? 0) + (h.degraded ?? 0);
  const runsFailed = d.runs.runsByState.FAILED ?? 0;
  const overdue = d.freshness.overdueSources;
  const due = d.freshness.jobsDueForVerification;
  const dueLabel = due >= DUE_VERIFICATION_CAP ? `${DUE_VERIFICATION_CAP}+` : fmtNum(due);
  const laggingQueues = d.queues.filter((q) => (q.oldestWaitingAgeMs ?? 0) > QUEUE_LAG_WARN_MS);
  const windowLabel = hours === 168 ? '7d' : `${hours}h`;
  const nothing =
    d.review.open === 0 &&
    overdue.length === 0 &&
    failingCount === 0 &&
    due === 0 &&
    runsFailed === 0 &&
    laggingQueues.length === 0;

  return (
    <>
      <ul className={styles.cards} aria-label="Key indicators">
        <InsightCard label="Open reviews" tone="warning">
          <Metric
            href="/review"
            value={fmtNum(d.review.open)}
            hint={
              d.review.oldestOpenAgeMs !== null
                ? `oldest ${fmtAge(d.review.oldestOpenAgeMs)}`
                : 'backlog empty'
            }
          />
        </InsightCard>
        <InsightCard label={`Runs (${windowLabel})`} tone="danger">
          <Metric href="/runs?state=FAILED" value={fmtNum(runsFailed)} hint="failed" />
          <Metric value={fmtNum(d.runs.activeRuns)} hint="active now" />
        </InsightCard>
        <InsightCard label="Source health" tone="info">
          <Metric href={SOURCES_UNHEALTHY_HREF} value={fmtNum(failingCount)} hint="failing/degraded" />
          <Metric value={fmtNum(overdue.length)} hint="overdue" />
        </InsightCard>
        <InsightCard label={`This window (${windowLabel})`} tone="success">
          <Metric href="/companies" value={`+${fmtNum(d.companies.created)}`} hint="companies" />
          <Metric href="/jobs" value={`+${fmtNum(d.jobs.created)}`} hint="jobs" />
        </InsightCard>
      </ul>

      <section className={styles.attention} aria-labelledby="next-title">
        <h2 id="next-title" className={styles.heading}>
          What needs attention
        </h2>
        <ul className={styles.rows}>
          {d.review.open > 0 ? (
            <AttentionRow
              href="/review"
              meta={
                d.review.oldestOpenAgeMs !== null
                  ? `oldest ${fmtAge(d.review.oldestOpenAgeMs)}`
                  : 'needs a decision'
              }
            >
              <strong>{fmtNum(d.review.open)}</strong> open review{d.review.open === 1 ? '' : 's'}
            </AttentionRow>
          ) : null}
          {overdue.length > 0 ? (
            <AttentionRow href="/sources" meta="check or reschedule">
              <strong>{fmtNum(overdue.length)}</strong> source{overdue.length === 1 ? '' : 's'} past freshness
            </AttentionRow>
          ) : null}
          {failingCount > 0 ? (
            <AttentionRow href={SOURCES_UNHEALTHY_HREF} meta="investigate last error">
              <strong>{fmtNum(failingCount)}</strong> source{failingCount === 1 ? '' : 's'} failing or
              degraded
            </AttentionRow>
          ) : null}
          {due > 0 ? (
            <AttentionRow href="/jobs" meta="next check overdue">
              <strong>{dueLabel}</strong> job{due === 1 ? '' : 's'} due verification
            </AttentionRow>
          ) : null}
          {runsFailed > 0 ? (
            <AttentionRow href="/runs?state=FAILED" meta="review and retry">
              <strong>{fmtNum(runsFailed)}</strong> failed run{runsFailed === 1 ? '' : 's'} ({windowLabel})
            </AttentionRow>
          ) : null}
          {laggingQueues.length > 0 ? (
            <AttentionRow href="/settings/system#queues" meta="oldest waiting over 5m">
              <strong>{fmtNum(laggingQueues.length)}</strong> queue{laggingQueues.length === 1 ? '' : 's'}{' '}
              lagging
            </AttentionRow>
          ) : null}
          {nothing ? (
            <li className={`${styles.row} ${styles.empty}`}>Nothing needs attention right now.</li>
          ) : null}
        </ul>
      </section>
    </>
  );
}
