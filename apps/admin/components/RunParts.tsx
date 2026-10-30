import Link from 'next/link';
import { seg } from '@/lib/api';
import { fmtBytes, fmtDateTime, fmtDuration, fmtNum, fmtPct } from '@/lib/format';
import type { ArtifactRef, Attempt, ErrorInfo, FanoutState, LogEntry } from '@/lib/types';
import { StatusBadge } from './Badge';
import { DataTable } from './DataTable';
import { JsonView, TextBlock } from './Json';
import { ArtifactLink, WorkflowLink } from './links';
import { KV } from './Section';
import { RelTime } from './Time';

const MAX_LOG_LINES = 200;

export function ErrorBox({ error }: { error: ErrorInfo | undefined }) {
  if (!error) return null;
  return (
    <div className="panel panel-bad small">
      <div>
        <strong>{error.name}</strong>
        {error.code ? (
          <>
            {' '}
            <code>{error.code}</code>
          </>
        ) : null}
        {error.retryable !== undefined ? (
          <span> · {error.retryable ? 'retryable' : 'not retryable'}</span>
        ) : null}
      </div>
      <div className="log-line">{error.message}</div>
      {error.details ? <JsonView value={error.details} label="details" /> : null}
      {error.stack ? <TextBlock text={error.stack} label="stack" /> : null}
    </div>
  );
}

export function AttemptsTable({ attempts }: { attempts: Attempt[] }) {
  return (
    <DataTable
      caption="Attempts"
      rows={attempts}
      rowKey={(a) => String(a.attempt)}
      empty="No attempts yet."
      columns={[
        { key: 'n', header: '#', numeric: true, cell: (a) => a.attempt },
        { key: 'worker', header: 'Worker', cell: (a) => <code className="small">{a.workerId}</code> },
        { key: 'status', header: 'Status', cell: (a) => <StatusBadge value={a.status} /> },
        { key: 'start', header: 'Started', cell: (a) => fmtDateTime(a.startedAt) },
        { key: 'dur', header: 'Duration', numeric: true, cell: (a) => fmtDuration(a.durationMs) },
        {
          key: 'err',
          header: 'Error',
          className: 'error-cell',
          cell: (a) =>
            a.error ? (
              <span className="text-bad small">
                {a.error.code ? <code>{a.error.code}</code> : null} {a.error.message}
              </span>
            ) : (
              <span className="muted">—</span>
            ),
        },
      ]}
    />
  );
}

export function Logs({ logs, max = MAX_LOG_LINES }: { logs: LogEntry[] | undefined; max?: number }) {
  if (!logs) return <p className="empty">Logs unavailable.</p>;
  if (!logs.length) return <p className="empty">No log entries.</p>;
  const shown = logs.slice(-max);
  return (
    <div className="logs" role="log" aria-label="Node logs">
      {logs.length > shown.length ? (
        <div className="muted">… {logs.length - shown.length} earlier entries omitted</div>
      ) : null}
      {shown.map((l, i) => (
        <div key={i} className={`log-line log-${l.level}`}>
          {fmtDateTime(l.at)} {l.level.toUpperCase().padEnd(5)} {l.msg}
          {l.data && Object.keys(l.data).length ? ` ${JSON.stringify(l.data)}` : ''}
        </div>
      ))}
    </div>
  );
}

export function FanoutStats({
  fanout,
  chunkStates,
  nodeRunId,
}: {
  fanout?: FanoutState;
  chunkStates: Record<string, number>;
  nodeRunId?: string;
}) {
  if (!fanout && !Object.keys(chunkStates).length) return null;
  return (
    <div className="callout">
      <h3>Fan-out</h3>
      {fanout ? (
        <KV
          items={[
            [
              'Items',
              `${fmtNum(fanout.succeededItems)} succeeded · ${fmtNum(fanout.failedItems)} failed · ${fmtNum(fanout.totalItems)} total`,
            ],
            [
              'Chunks',
              `${fmtNum(fanout.completedChunks)} / ${fmtNum(fanout.totalChunks)} completed · ${fmtNum(fanout.inFlight)} in flight (batch ${fanout.batchSize}, concurrency ${fanout.concurrency})`,
            ],
            [
              'Failure policy',
              `${fanout.failurePolicy} (max failure ratio ${fmtPct(fanout.maxFailureRatio, 0)})`,
            ],
            [
              'Body',
              fanout.bodyWorkflow ? (
                <WorkflowLink id={fanout.bodyWorkflow} />
              ) : fanout.bodyCapability ? (
                <code>{fanout.bodyCapability}</code>
              ) : null,
            ],
            ['Last pump', <RelTime key="p" iso={fanout.lastPumpAt} />],
          ]}
        />
      ) : null}
      {Object.keys(chunkStates).length ? (
        <p className="small">
          Chunk states:{' '}
          {Object.entries(chunkStates).map(([k, v]) => (
            <span key={k} className="label-chip">
              <StatusBadge value={k} /> {fmtNum(v)}
            </span>
          ))}
        </p>
      ) : null}
      {nodeRunId ? (
        <Link href={`/node-runs/${seg(nodeRunId)}#chunks`} className="small">
          Chunk list →
        </Link>
      ) : null}
    </div>
  );
}

export function ArtifactsTable({ artifacts }: { artifacts: ArtifactRef[] }) {
  return (
    <DataTable
      caption="Artifacts"
      rows={artifacts}
      rowKey={(a) => a.artifactId}
      empty="No artifacts produced."
      columns={[
        { key: 'id', header: 'Artifact', cell: (a) => <ArtifactLink id={a.artifactId} /> },
        { key: 'mime', header: 'Type', cell: (a) => <code className="small">{a.mimeType}</code> },
        { key: 'size', header: 'Size', numeric: true, cell: (a) => fmtBytes(a.size) },
        {
          key: 'sha',
          header: 'sha256',
          cell: (a) => <code className="small">{a.sha256.slice(0, 16)}…</code>,
        },
        { key: 'at', header: 'Created', cell: (a) => <RelTime iso={a.createdAt} /> },
        {
          key: 'pv',
          header: '',
          cell: (a) => (
            <ArtifactLink id={a.artifactId} preview={100_000}>
              preview
            </ArtifactLink>
          ),
        },
      ]}
    />
  );
}
