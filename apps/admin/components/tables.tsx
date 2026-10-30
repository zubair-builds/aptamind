import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { fmtDuration, fmtLocation, humanize } from '@/lib/format';
import type { AuditEvent, Job, Observation, ReviewItem, Snapshot, WorkflowRun } from '@/lib/types';
import { StatusBadge } from './Badge';
import { DataTable } from './DataTable';
import { JsonView } from './Json';
import {
  ArtifactLink,
  CompanyLink,
  EntityLink,
  JobLink,
  ObservationLink,
  ReviewLink,
  RunLink,
  SnapshotLink,
  SourceLink,
  type SourceNames,
  WorkflowLink,
} from './links';
import { ConflictFields } from './records/facts/ConflictFields';
import { FactSummary } from './records/facts/FactSummary';
import { SponsorshipValue } from './SponsorshipValue';
import { RelTime } from './Time';

export function RunsTable({
  runs,
  caption = 'Runs',
  showWorkflow = true,
}: {
  runs: WorkflowRun[];
  caption?: string;
  showWorkflow?: boolean;
}) {
  return (
    <DataTable
      caption={caption}
      rows={runs}
      rowKey={(r) => r._id}
      columns={[
        { key: 'id', header: 'Run', cell: (r) => <RunLink id={r._id} /> },
        showWorkflow && {
          key: 'wf',
          header: 'Workflow',
          cell: (r) => (
            <>
              <WorkflowLink id={r.workflowKey} />
              <span className="muted">@{r.workflowVersion}</span>
            </>
          ),
        },
        { key: 'state', header: 'State', cell: (r) => <StatusBadge value={r.state} /> },
        {
          key: 'trigger',
          header: 'Trigger',
          cell: (r) => (
            <>
              {r.trigger.kind}
              {r.trigger.actor ? <span className="muted small"> ({r.trigger.actor.id})</span> : null}
            </>
          ),
        },
        { key: 'created', header: 'Created', cell: (r) => <RelTime iso={r.createdAt} /> },
        { key: 'dur', header: 'Duration', numeric: true, cell: (r) => fmtDuration(r.durationMs) },
        {
          key: 'lineage',
          header: 'Lineage',
          cell: (r) =>
            r.parent ? (
              <span className="small">
                child of <RunLink id={r.parent.runId} />
                {r.parent.itemIndex !== undefined ? <> #{r.parent.itemIndex}</> : null}
              </span>
            ) : (
              <span className="muted small">top-level</span>
            ),
        },
        {
          key: 'labels',
          header: 'Labels',
          cell: (r) =>
            Object.keys(r.labels ?? {}).length ? (
              <span className="small">
                {Object.entries(r.labels).map(([k, v]) => (
                  <span key={k} className="label-chip">
                    {k}=
                    {k === 'sourceId' ? (
                      <SourceLink id={v} />
                    ) : k === 'companyId' ? (
                      <CompanyLink id={v} />
                    ) : k === 'jobId' ? (
                      <JobLink id={v} />
                    ) : (
                      v
                    )}
                  </span>
                ))}
              </span>
            ) : (
              <span className="muted">—</span>
            ),
        },
        {
          key: 'error',
          header: 'Error',
          className: 'error-cell',
          cell: (r) =>
            r.error ? (
              <span className="text-bad small" title={r.error.message}>
                {r.error.code ? <code>{r.error.code}</code> : null} {r.error.message.slice(0, 160)}
              </span>
            ) : r.failedNodeIds?.length ? (
              <span className="text-bad small">failed: {r.failedNodeIds.join(', ')}</span>
            ) : (
              <span className="muted">—</span>
            ),
        },
      ]}
    />
  );
}

export function ReviewTable({ items, caption = 'Review items' }: { items: ReviewItem[]; caption?: string }) {
  return (
    <DataTable
      caption={caption}
      rows={items}
      rowKey={(r) => r._id}
      columns={[
        { key: 'prio', header: 'Priority', numeric: true, cell: (r) => r.priority },
        { key: 'sev', header: 'Severity', cell: (r) => <StatusBadge value={r.severity} kind="severity" /> },
        { key: 'status', header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
        { key: 'type', header: 'Type', cell: (r) => humanize(r.type) },
        {
          key: 'subject',
          header: 'Subject',
          cell: (r) => (
            <Link href={`/review/${encodeURIComponent(r._id)}`}>
              <strong>{r.subject}</strong>
            </Link>
          ),
        },
        {
          key: 'reason',
          header: 'Reason',
          className: 'wrap-cell',
          cell: (r) => <span className="small">{r.reason}</span>,
        },
        {
          key: 'entity',
          header: 'Entity',
          cell: (r) => (
            <span className="small">
              {r.entity.kind} <EntityLink kind={r.entity.kind} id={r.entity.id} />
            </span>
          ),
        },
        { key: 'occ', header: 'Seen', numeric: true, cell: (r) => r.occurrences },
        { key: 'age', header: 'Age', cell: (r) => <RelTime iso={r.createdAt} /> },
      ]}
    />
  );
}

export function AuditTable({ events, caption = 'Audit events' }: { events: AuditEvent[]; caption?: string }) {
  return (
    <DataTable
      caption={caption}
      rows={events}
      rowKey={(r) => r._id}
      empty="No audit events."
      columns={[
        { key: 'at', header: 'When', cell: (r) => <RelTime iso={r.at} abs /> },
        { key: 'actor', header: 'Actor', cell: (r) => `${r.actor.kind}:${r.actor.id}` },
        { key: 'action', header: 'Action', cell: (r) => <code>{r.action}</code> },
        {
          key: 'entity',
          header: 'Entity',
          cell: (r) => (
            <span className="small">
              {r.entity.kind} <EntityLink kind={r.entity.kind} id={r.entity.id} />
            </span>
          ),
        },
        {
          key: 'refs',
          header: 'Refs',
          cell: (r) => (
            <span className="small">
              {r.reviewItemId ? (
                <>
                  review <ReviewLink id={r.reviewItemId} />{' '}
                </>
              ) : null}
              {r.runId ? (
                <>
                  run <RunLink id={r.runId} />
                </>
              ) : null}
              {!r.reviewItemId && !r.runId ? <span className="muted">—</span> : null}
            </span>
          ),
        },
        {
          key: 'details',
          header: 'Details',
          cell: (r) =>
            Object.keys(r.details ?? {}).length ? (
              <JsonView value={r.details} label="details" />
            ) : (
              <span className="muted">—</span>
            ),
        },
      ]}
    />
  );
}

export function ObservationsTable({
  observations,
  sources,
  caption = 'Observations',
}: {
  observations: Observation[];
  sources?: SourceNames;
  caption?: string;
}) {
  return (
    <DataTable
      caption={caption}
      rows={observations}
      rowKey={(r) => r._id}
      columns={[
        { key: 'id', header: 'Observation', cell: (r) => <ObservationLink id={r._id} /> },
        { key: 'source', header: 'Source', cell: (r) => <SourceLink id={r.sourceId} names={sources} /> },
        {
          key: 'authority',
          header: 'Authority',
          cell: (r) => {
            const tier = sources?.get(r.sourceId)?.authority?.tier;
            return tier ? humanize(tier) : <span className="muted">—</span>;
          },
        },
        {
          key: 'ext',
          header: 'External id',
          cell: (r) =>
            r.externalId ? <code className="small">{r.externalId}</code> : <span className="muted">—</span>,
        },
        {
          key: 'res',
          header: 'Resolution',
          cell: (r) => (
            <span className="small">
              <StatusBadge value={r.resolution.state} />
              {r.resolution.method ? <> {r.resolution.method}</> : null}
              {r.resolution.confidence ? <span className="muted"> ({r.resolution.confidence})</span> : null}
              {r.resolution.reviewItemId ? (
                <>
                  {' '}
                  <ReviewLink id={r.resolution.reviewItemId}>review</ReviewLink>
                </>
              ) : null}
            </span>
          ),
        },
        { key: 'first', header: 'First seen', cell: (r) => <RelTime iso={r.firstObservedAt} /> },
        { key: 'last', header: 'Last seen', cell: (r) => <RelTime iso={r.lastObservedAt} /> },
        { key: 'seen', header: 'Seen', numeric: true, cell: (r) => r.seenCount },
        {
          key: 'parser',
          header: 'Parser',
          cell: (r) => (
            <span className="small mono">
              {r.parser.name}@{r.parser.version}
              {r.ai ? <span className="muted"> · AI {r.ai.model}</span> : null}
            </span>
          ),
        },
        {
          key: 'artifact',
          header: 'Raw',
          cell: (r) => (
            <span className="small">
              {r.artifactId ? <ArtifactLink id={r.artifactId}>artifact</ArtifactLink> : null}
              {r.artifactId && r.snapshotId ? ' · ' : null}
              {r.snapshotId ? <SnapshotLink id={r.snapshotId}>snapshot</SnapshotLink> : null}
              {!r.artifactId && !r.snapshotId ? <span className="muted">—</span> : null}
            </span>
          ),
        },
        {
          key: 'warn',
          header: 'Warnings',
          cell: (r) =>
            r.warnings?.length ? (
              <span className="text-warn small">{r.warnings.join('; ')}</span>
            ) : (
              <span className="muted">—</span>
            ),
        },
      ]}
    />
  );
}

export function JobsTable({
  jobs,
  caption = 'Jobs',
  showCompany = true,
}: {
  jobs: Job[];
  caption?: string;
  showCompany?: boolean;
}) {
  return (
    <DataTable
      caption={caption}
      rows={jobs}
      rowKey={(r) => r._id}
      columns={[
        {
          key: 'title',
          header: 'Title',
          cell: (r) => (
            <JobLink id={r._id}>
              <strong>{r.identity.title.value ?? r.identity.normalizedTitle}</strong>
            </JobLink>
          ),
        },
        showCompany && { key: 'company', header: 'Company', cell: (r) => <CompanyLink id={r.companyId} /> },
        { key: 'state', header: 'State', cell: (r) => <StatusBadge value={r.lifecycle.state} /> },
        {
          key: 'wm',
          header: 'Work model',
          cell: (r) => <FactSummary fact={r.geography.workModel} render={(v) => humanize(v)} />,
        },
        {
          key: 'scope',
          header: 'Remote scope',
          cell: (r) => <FactSummary fact={r.geography.remoteScope} render={(v) => humanize(v.type)} />,
        },
        {
          key: 'loc',
          header: 'Locations',
          className: 'wrap-cell',
          cell: (r) =>
            r.geography.normalizedLocations?.length
              ? r.geography.normalizedLocations.map((l) => fmtLocation(l)).join(' · ')
              : (r.geography.listedLocations ?? []).join(' · ') || <span className="muted">—</span>,
        },
        {
          key: 'spons',
          header: 'Sponsorship',
          cell: (r) => (
            <FactSummary fact={r.immigration.sponsorship} render={(v) => <SponsorshipValue v={v} />} />
          ),
        },
        {
          key: 'comp',
          header: 'Salary',
          cell: (r) => <FactSummary fact={r.compensation} render={(v) => <StatusBadge value={v.status} />} />,
        },
        { key: 'seen', header: 'Last seen', cell: (r) => <RelTime iso={r.lifecycle.lastSeenAt} /> },
        {
          key: 'q',
          header: 'Quality',
          cell: (r) => (
            <span className="small">
              {r.quality.sourceCount} src
              <ConflictFields record={r} fields={r.quality.conflictFields} variant="count" />
              {r.quality.openReviewCount ? (
                <span className="text-warn"> · {r.quality.openReviewCount} reviews</span>
              ) : null}
            </span>
          ),
        },
      ]}
    />
  );
}

export function SnapshotsTable({
  snapshots,
  caption = 'Snapshots',
  renderActions,
}: {
  snapshots: Snapshot[];
  caption?: string;
  renderActions?: (s: Snapshot) => ReactNode;
}) {
  return (
    <DataTable
      caption={caption}
      rows={snapshots}
      rowKey={(r) => r._id}
      columns={[
        { key: 'id', header: 'Snapshot', cell: (r) => <SnapshotLink id={r._id} /> },
        { key: 'via', header: 'Via', cell: (r) => r.via },
        {
          key: 'type',
          header: 'Content type',
          cell: (r) => <span className="small mono">{r.contentType ?? r.artifact.mimeType}</span>,
        },
        { key: 'items', header: 'Items', numeric: true, cell: (r) => r.itemCount ?? '—' },
        { key: 'fetches', header: 'Fetches', numeric: true, cell: (r) => r.fetchCount },
        { key: 'last', header: 'Last fetched', cell: (r) => <RelTime iso={r.lastFetchedAt} /> },
        { key: 'http', header: 'HTTP', numeric: true, cell: (r) => r.httpStatus ?? '—' },
        {
          key: 'artifact',
          header: 'Content',
          cell: (r) => (
            <span className="small">
              <ArtifactLink id={r.artifact.artifactId} preview={200_000}>
                preview
              </ArtifactLink>{' '}
              · <ArtifactLink id={r.artifact.artifactId}>full</ArtifactLink>
            </span>
          ),
        },
        {
          key: 'runs',
          header: 'Runs',
          cell: (r) =>
            r.runIds?.length
              ? r.runIds.slice(-3).map((id, i) => (
                  <Fragment key={id}>
                    {i > 0 ? ' ' : null}
                    <RunLink id={id} />
                  </Fragment>
                ))
              : '—',
        },
        renderActions ? { key: 'actions', header: 'Actions', cell: (r) => renderActions(r) } : null,
      ]}
    />
  );
}
