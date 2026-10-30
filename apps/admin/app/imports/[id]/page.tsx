import type { ReactNode } from 'react';
import { ApiErrorPanel } from '@/components/ApiError';
import { StatusBadge } from '@/components/Badge';
import { AutoRefresh } from '@/components/imports/AutoRefresh';
import s from '@/components/imports/imports.module.css';
import {
  ATS_REPORT_CODES,
  countLabels,
  importTypeLabel,
  traceSourcesLabel,
} from '@/components/imports/labels';
import { ArtifactLink, CompanyLink, ReviewLink, RunLink, SnapshotLink, SourceLink } from '@/components/links';
import { PageHeader, Section } from '@/components/Section';
import { CopyButton } from '@/components/ui/CopyButton';
import { ErrorState } from '@/components/ui/ErrorState';
import { PropertyList } from '@/components/ui/PropertyList';
import { Time } from '@/components/ui/Time';
import { fmtBytes, fmtNum } from '@/lib/format';
import { getImport } from '@/lib/imports';
import type { ImportDetail } from '@/lib/types';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { id } = await params;
  return { title: `Import ${id}` };
}

function Counts({ imp }: { imp: ImportDetail }) {
  const processing = imp.status === 'processing';
  return (
    <dl className={s.counts}>
      {countLabels(imp.type).map(([key, label]) => {
        const v = imp.counts[key];
        // A count an older API build does not send at all is left out, not shown as unknown.
        if (v === undefined) return null;
        return (
          <div key={key} className={s.count}>
            <dt>{label}</dt>
            <dd
              title={
                v === null ? (processing ? 'Not known yet' : 'Not counted for this import type') : undefined
              }
            >
              {v === null ? <span className="muted">—</span> : fmtNum(v)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function AtsReportCodes() {
  return (
    <details className={s.codes}>
      <summary>What the row codes in the report mean</summary>
      <dl>
        {ATS_REPORT_CODES.map(([code, text]) => (
          <div key={code}>
            <dt className="mono small">{code}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function IdList({ ids, render, empty }: { ids: string[]; render: (id: string) => ReactNode; empty: string }) {
  if (!ids.length) return <p className="small muted">{empty}</p>;
  return (
    <ul className={s.idList}>
      {ids.map((id) => (
        <li key={id}>{render(id)}</li>
      ))}
    </ul>
  );
}

export default async function ImportPage({ params }: { params: Params }) {
  const { id } = await params;
  const res = await getImport(id);
  // AutoRefresh and the status line sit first in both branches, so a failed refresh keeps them
  // mounted: polling backs off and continues, and the live region keeps announcing.
  if (!res.ok) {
    const missing = res.error.status === 404;
    return (
      <>
        {missing ? null : <AutoRefresh failing />}
        <PageHeader title="Import" />
        {missing ? null : (
          <p className={s.processing} role="status">
            The import could not be loaded. Trying again.
          </p>
        )}
        <ApiErrorPanel error={res.error} title={missing ? 'Import not found' : undefined} />
      </>
    );
  }
  const imp = res.data;
  const processing = imp.status === 'processing';
  const trace = imp.trace;
  const sourceLink = <SourceLink id={imp.source?.id ?? imp.sourceId}>{imp.source?.name}</SourceLink>;
  return (
    <>
      {processing ? <AutoRefresh /> : null}
      <PageHeader
        title={imp.fileName}
        subtitle={
          <>
            {importTypeLabel(imp.type)} · <StatusBadge value={imp.status} /> · into {sourceLink} ·{' '}
            <Time value={imp.createdAt} />
          </>
        }
      />
      {/* Always mounted, so finishing is announced to screen readers. */}
      <p className={s.processing} role="status">
        {processing
          ? 'Processing. This page refreshes every few seconds.'
          : `Import finished: ${imp.status.replaceAll('_', ' ')}.`}
      </p>
      {imp.error ? (
        <ErrorState
          title="The run could not be started"
          message={
            <>
              <code>{imp.error.code}</code>: {imp.error.message}
            </>
          }
          retry={false}
          announce={false}
        />
      ) : null}

      <Section title="Results" id="results" description="Counted by the API from the run and its outputs.">
        <Counts imp={imp} />
      </Section>

      <Section title="Details" id="details">
        <PropertyList
          items={[
            { label: 'Type', value: importTypeLabel(imp.type) },
            { label: 'Status', value: <StatusBadge value={imp.status} /> },
            {
              label: 'Source',
              value: (
                <>
                  {sourceLink} <span className="muted small">{imp.source?.provider}</span>
                </>
              ),
            },
            {
              label: 'Run',
              value: imp.runId ? <RunLink id={imp.runId} /> : <span className="muted">Not started</span>,
            },
            {
              label: 'Snapshot',
              value: (
                <>
                  <SnapshotLink id={imp.snapshotId} />
                  {imp.snapshotUnchanged ? (
                    <span className="muted small"> · same file as an earlier snapshot of this source</span>
                  ) : null}
                </>
              ),
            },
            { label: 'Uploaded file', value: <ArtifactLink id={imp.artifactId} /> },
            // Older API builds do not send a report; leave the row out rather than show "none".
            trace && trace.reportArtifactId !== undefined
              ? {
                  label: 'Import report',
                  value: trace.reportArtifactId ? (
                    <>
                      <ArtifactLink id={trace.reportArtifactId}>
                        Import report (row warnings and errors)
                      </ArtifactLink>
                      {imp.type === 'ats_boards' ? <AtsReportCodes /> : null}
                    </>
                  ) : (
                    <span className="muted">{processing ? 'Not ready yet' : 'No report'}</span>
                  ),
                }
              : null,
            { label: 'File name', value: imp.fileName },
            { label: 'Content type', value: <span className="mono">{imp.contentType}</span> },
            { label: 'Size', value: fmtBytes(imp.bytes) },
            {
              label: 'Content hash',
              value: (
                <span className="nowrap">
                  <span className="mono small" title="SHA-256 of the uploaded bytes">
                    {imp.contentHash}
                  </span>{' '}
                  <CopyButton value={imp.contentHash} label="Copy hash" />
                </span>
              ),
            },
            { label: 'Created', value: <Time value={imp.createdAt} mode="absolute" /> },
            {
              label: 'Created by',
              value: imp.createdBy ? (
                <span className="mono small">
                  {imp.createdBy.kind}:{imp.createdBy.id}
                </span>
              ) : null,
            },
            { label: 'Started', value: <Time value={imp.startedAt} mode="absolute" /> },
            { label: 'Finished', value: <Time value={imp.finishedAt} mode="absolute" /> },
            { label: 'Import id', value: <span className="mono small">{imp._id}</span> },
          ]}
        />
      </Section>

      <Section
        title="What this import touched"
        id="trace"
        description={
          trace?.truncated ? 'Each list shows at most 200 items.' : 'Records this import changed or opened.'
        }
      >
        <PropertyList
          items={[
            {
              label: `Reviews opened (${fmtNum(trace?.reviewIds.length ?? 0)})`,
              value: (
                <IdList
                  ids={trace?.reviewIds ?? []}
                  render={(x) => <ReviewLink id={x} />}
                  empty={processing ? 'None yet.' : 'None.'}
                />
              ),
            },
            {
              label: `Companies (${fmtNum(trace?.companyIds.length ?? 0)})`,
              value: (
                <IdList
                  ids={trace?.companyIds ?? []}
                  render={(x) => <CompanyLink id={x} />}
                  empty={processing ? 'None yet.' : 'None.'}
                />
              ),
            },
            {
              label: `${traceSourcesLabel(imp.type)} (${fmtNum(trace?.sourceIds.length ?? 0)})`,
              value: (
                <IdList
                  ids={trace?.sourceIds ?? []}
                  // Only the import's own source has a name in the detail; others show their id.
                  render={(x) => (
                    <SourceLink id={x}>{x === imp.source?.id ? imp.source.name : undefined}</SourceLink>
                  )}
                  empty={processing ? 'None yet.' : 'None.'}
                />
              ),
            },
          ]}
        />
      </Section>
    </>
  );
}
