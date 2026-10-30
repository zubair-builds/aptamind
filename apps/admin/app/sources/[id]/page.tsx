import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
import { ApiErrorPanel } from '@/components/ApiError';
import { Badge, BoolBadge, StatusBadge } from '@/components/Badge';
import { JsonView } from '@/components/Json';
import { CompanyLink, ExternalLink, RunLink, SnapshotLink, WorkflowLink } from '@/components/links';
import { KV, PageHeader, Section } from '@/components/Section';
import { AuditTable, ReviewTable, RunsTable, SnapshotsTable } from '@/components/tables';
import { RelTime } from '@/components/Time';
import {
  reprocessSnapshotAction,
  runSourceAction,
  setScheduleEnabledAction,
  setSourceEnabledAction,
  updateSourceAction,
  uploadSnapshotAction,
} from '@/lib/actions';
import { apiGet, seg } from '@/lib/api';
import { fmtAge, fmtMinutes, humanize } from '@/lib/format';
import type { SourceDetail } from '@/lib/types';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { id } = await params;
  return { title: `Source ${id}` };
}

export default async function SourceDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const res = await apiGet<SourceDetail>(`/api/sources/${seg(id)}`);
  if (!res.ok) {
    return (
      <>
        <PageHeader title="Source" />
        <ApiErrorPanel error={res.error} />
      </>
    );
  }
  const { source: s, runs, snapshots, schedule, openReviews, audit } = res.data;
  const path = `/sources/${seg(s._id)}`;
  const ageMs = s.health.lastSuccessAt ? Date.now() - new Date(s.health.lastSuccessAt).getTime() : null;
  const maxAgeMs = s.freshness.maxAgeMinutes * 60_000;
  const overdue = s.enabled && (ageMs === null || ageMs > maxAgeMs);
  const g = s.governance;
  const editTemplate = {
    name: s.name,
    endpoint: s.endpoint,
    acquisition: { config: s.acquisition.config, workflowVersion: s.acquisition.workflowVersion ?? null },
    schedule: s.schedule ?? null,
    freshness: s.freshness,
    labels: s.labels ?? {},
  };

  return (
    <>
      <PageHeader
        title={s.name}
        subtitle={
          <>
            <code>{s.key}</code>
            <code className="id">{s._id}</code>
            <BoolBadge value={s.enabled} yes="enabled" no="disabled" />
            <StatusBadge value={s.health.status} />
            {overdue ? <Badge tone="warn">freshness overdue</Badge> : null}
          </>
        }
        actions={
          <>
            <ActionForm
              action={runSourceAction}
              submitLabel="Run now"
              variant="primary"
              inline
              hidden={{ sourceId: s._id, revalidate: path }}
            />
            <ActionForm
              action={setSourceEnabledAction}
              submitLabel={s.enabled ? 'Disable' : 'Enable'}
              variant={s.enabled ? 'danger' : 'default'}
              inline
              confirmMessage={s.enabled ? `Disable ${s.key}? Scheduled runs will stop.` : undefined}
              hidden={{ sourceId: s._id, enabled: s.enabled ? 'false' : 'true', revalidate: path }}
            />
          </>
        }
      />

      <div className="grid-2">
        <Section title="Health" id="health">
          <KV
            items={[
              ['Status', <StatusBadge key="s" value={s.health.status} />],
              [
                'Consecutive failures',
                s.health.consecutiveFailures ? (
                  <span className="text-bad">{s.health.consecutiveFailures}</span>
                ) : (
                  '0'
                ),
              ],
              ['Last attempt', <RelTime key="a" iso={s.health.lastAttemptAt} abs />],
              ['Last success', <RelTime key="b" iso={s.health.lastSuccessAt} abs />],
              ['Last failure', <RelTime key="c" iso={s.health.lastFailureAt} abs />],
              [
                'Last error',
                s.health.lastError ? <span className="text-bad">{s.health.lastError}</span> : null,
              ],
              ['Last run', s.health.lastRunId ? <RunLink id={s.health.lastRunId} /> : null],
              [
                'Last snapshot',
                s.health.lastSnapshotId ? <SnapshotLink id={s.health.lastSnapshotId} /> : null,
              ],
              ['Last item count', s.health.lastItemCount ?? null],
              ['Last complete import', <RelTime key="d" iso={s.health.lastCompleteImportStartedAt} abs />],
              s.stats
                ? [
                    'Attempts / successes / failures',
                    `${s.stats.attempts} / ${s.stats.successes} / ${s.stats.failures}`,
                  ]
                : null,
            ]}
          />
        </Section>

        <Section title="Schedule & freshness" id="schedule">
          <KV
            items={[
              [
                'Source schedule',
                s.schedule ? (
                  <>
                    {s.schedule.cron ? <code>{s.schedule.cron}</code> : null}
                    {s.schedule.intervalMinutes ? (
                      <>every {fmtMinutes(s.schedule.intervalMinutes)}</>
                    ) : null}{' '}
                    ({s.schedule.timezone})
                  </>
                ) : (
                  <span className="muted">manual only</span>
                ),
              ],
              ['Freshness policy', <code key="p">{s.freshness.policyClass}</code>],
              ['Max age', fmtMinutes(s.freshness.maxAgeMinutes)],
              [
                'Age of last success',
                ageMs === null ? (
                  <span className="text-warn">never succeeded</span>
                ) : (
                  <span className={ageMs > maxAgeMs ? 'text-warn' : undefined}>
                    {fmtAge(ageMs)} {ageMs > maxAgeMs ? '(overdue)' : '(fresh)'}
                  </span>
                ),
              ],
            ]}
          />
          <h3 style={{ marginTop: 10 }}>Workflow schedule</h3>
          {schedule ? (
            <>
              <KV
                items={[
                  ['Schedule id', <code key="i">{schedule._id}</code>],
                  ['Enabled', <BoolBadge key="e" value={schedule.enabled} yes="enabled" no="disabled" />],
                  [
                    'Trigger',
                    schedule.cron ? (
                      <code>{schedule.cron}</code>
                    ) : (
                      `every ${fmtMinutes(schedule.intervalMinutes)}`
                    ),
                  ],
                  ['Next fire', <RelTime key="n" iso={schedule.nextFireAt} abs />],
                  ['Last fired', <RelTime key="l" iso={schedule.lastFiredAt} abs />],
                  ['Last run', schedule.lastRunId ? <RunLink id={schedule.lastRunId} /> : null],
                  ['Fire count', schedule.fireCount],
                  [
                    'Last error',
                    schedule.lastError ? <span className="text-bad">{schedule.lastError}</span> : null,
                  ],
                ]}
              />
              <ActionForm
                action={setScheduleEnabledAction}
                submitLabel={schedule.enabled ? 'Disable schedule' : 'Enable schedule'}
                inline
                hidden={{
                  scheduleId: schedule._id,
                  enabled: schedule.enabled ? 'false' : 'true',
                  revalidate: path,
                }}
              />
            </>
          ) : (
            <p className="empty">No workflow schedule for this source.</p>
          )}
        </Section>
      </div>

      <div className="grid-2">
        <Section title="Origin & acquisition" id="origin">
          <KV
            items={[
              ['Category', humanize(s.category)],
              ['Provider', <code key="p">{s.provider}</code>],
              ['Endpoint URL', s.endpoint.url ? <ExternalLink href={s.endpoint.url} /> : null],
              ['Board token', s.endpoint.boardToken ? <code>{s.endpoint.boardToken}</code> : null],
              ['Company', s.companyId ? <CompanyLink id={s.companyId} /> : null],
              [
                'Acquisition workflow',
                <>
                  <WorkflowLink id={s.acquisition.workflowKey} />
                  {s.acquisition.workflowVersion ? (
                    <span className="muted"> pinned @{s.acquisition.workflowVersion}</span>
                  ) : (
                    <span className="muted"> (latest)</span>
                  )}
                </>,
              ],
              ['Config', <JsonView key="c" value={s.acquisition.config} label="acquisition.config" />],
              [
                'Credential refs',
                s.acquisition.credentialRefs.length
                  ? s.acquisition.credentialRefs.map((c) => `${c.kind}:${c.name}`).join(', ')
                  : null,
              ],
              [
                'Labels',
                Object.keys(s.labels ?? {}).length ? <JsonView value={s.labels} label="labels" /> : null,
              ],
              ['Created', <RelTime key="cr" iso={s.createdAt} abs />],
              ['Updated', <RelTime key="up" iso={s.updatedAt} abs />],
            ]}
          />
        </Section>
        <Section title="Authority & governance" id="authority">
          <KV
            items={[
              [
                'Authority tier',
                <Badge key="t" tone="info">
                  {humanize(s.authority.tier)}
                </Badge>,
              ],
              [
                'Authoritative for',
                s.authority.authoritativeFor.length ? s.authority.authoritativeFor.join('; ') : null,
              ],
              [
                'Listing is complete',
                <BoolBadge
                  key="l"
                  value={s.authority.listingIsComplete}
                  yes="yes — absence is meaningful"
                  no="no"
                />,
              ],
              ['Access method', g ? humanize(g.accessMethod) : null],
              ['Terms notes', g?.termsNotes],
              ['Commercial use', g?.commercialUseNotes],
              ['Retention restrictions', g?.retentionRestrictions],
              ['Redistribution restrictions', g?.redistributionRestrictions],
              ['Crawl policy', g?.crawlPolicy],
              ['Rate limit / min', g?.rateLimitPerMinute ?? null],
              [
                'Last compliance review',
                g?.lastComplianceReviewAt ? <RelTime iso={g.lastComplianceReviewAt} abs /> : null,
              ],
            ]}
          />
        </Section>
      </div>

      <Section
        title="Recent runs"
        id="runs"
        actions={
          <Link href={`/runs?sourceId=${seg(s._id)}&all=true`} className="small">
            All runs for this source →
          </Link>
        }
      >
        <RunsTable runs={runs} caption="Recent runs" />
      </Section>

      <Section
        title="Snapshots"
        id="snapshots"
        description="Raw source snapshots (immutable, content-addressed). Content opens as plain text."
      >
        <SnapshotsTable
          snapshots={snapshots}
          renderActions={(snap) => (
            <ActionForm
              action={reprocessSnapshotAction}
              submitLabel="Reprocess"
              inline
              confirmMessage={`Re-run ${s.acquisition.workflowKey} on snapshot ${snap._id}?`}
              hidden={{ snapshotId: snap._id, revalidate: path }}
            />
          )}
        />
        <p className="small" style={{ marginTop: 8 }}>
          To add a file to this source, use{' '}
          <Link href={`/imports/new/snapshot?sourceId=${encodeURIComponent(s._id)}`}>Import a snapshot</Link>.
          It keeps an import record you can follow.
        </p>
        <details>
          <summary>Advanced: upload a raw snapshot file</summary>
          <p className="small muted">
            No import record is kept. The file body is sent raw to{' '}
            <code>POST /api/sources/{s._id}/snapshots</code> with its content type (the API accepts CSV, JSON,
            NDJSON, plain text and octet-stream).
          </p>
          <ActionForm
            action={uploadSnapshotAction}
            submitLabel="Upload"
            hidden={{ sourceId: s._id, revalidate: path }}
          >
            <label className="field">
              <span>File</span>
              <input type="file" name="file" required />
            </label>
            <label className="field">
              <span>Content type</span>
              <select name="contentType" defaultValue="">
                <option value="">Detect from file name</option>
                <option value="text/csv">text/csv</option>
                <option value="application/json">application/json</option>
                <option value="application/x-ndjson">application/x-ndjson</option>
                <option value="text/plain">text/plain</option>
                <option value="application/octet-stream">application/octet-stream</option>
              </select>
            </label>
            <label className="field field-check">
              <input type="checkbox" name="process" defaultChecked /> Process immediately (start the
              acquisition workflow on this snapshot)
            </label>
          </ActionForm>
        </details>
      </Section>

      <div className="grid-2">
        <Section title={`Open reviews (${openReviews.length})`} id="reviews">
          <ReviewTable items={openReviews} caption="Open reviews" />
        </Section>
        <Section title="Audit" id="audit">
          <AuditTable events={audit} />
        </Section>
      </div>

      <Section title="Edit configuration" id="edit">
        <details>
          <summary>Edit (JSON patch → PATCH /api/sources/:id)</summary>
          <p className="small muted">
            Only the fields present are changed. Allowed: <code>name</code>, <code>endpoint</code>,{' '}
            <code>acquisition.config</code>, <code>acquisition.workflowVersion</code>, <code>schedule</code>{' '}
            (null removes it), <code>freshness</code>, <code>governance</code>, <code>labels</code>.
          </p>
          <ActionForm
            action={updateSourceAction}
            submitLabel="Save changes"
            hidden={{ sourceId: s._id, revalidate: path }}
          >
            <label className="field">
              <span>Patch</span>
              <textarea
                name="patch"
                rows={16}
                defaultValue={JSON.stringify(editTemplate, null, 2)}
                spellCheck={false}
              />
            </label>
          </ActionForm>
        </details>
      </Section>
    </>
  );
}
