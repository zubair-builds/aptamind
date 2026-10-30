import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
import { ApiErrorPanel } from '@/components/ApiError';
import { Badge, StatusBadge } from '@/components/Badge';
import { JsonView, TextBlock } from '@/components/Json';
import { ArtifactLink, NodeRunLink, RunLink, SourceLink, WorkflowLink } from '@/components/links';
import { ArtifactsTable, AttemptsTable, ErrorBox, FanoutStats, Logs } from '@/components/RunParts';
import { KV, PageHeader, Section } from '@/components/Section';
import { RelTime } from '@/components/Time';
import { cancelRunAction, resumeNodeRunAction, retryNodeRunAction } from '@/lib/actions';
import { apiGet, seg } from '@/lib/api';
import { downstreamOf, topoOrder, upstreamOf } from '@/lib/dag';
import { fmtBytes, fmtDateTime, fmtDuration } from '@/lib/format';
import type { LogEntry, NodeRun, RunDetail, RunDetailNode, WorkflowEdge } from '@/lib/types';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { id } = await params;
  return { title: `Run ${id}` };
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function NodeCard({
  node,
  index,
  edges,
  runId,
  logs,
  path,
}: {
  node: RunDetailNode;
  index: number;
  edges: WorkflowEdge[];
  runId: string;
  logs: LogEntry[] | undefined;
  path: string;
}) {
  const nr = node.nodeRun;
  const up = upstreamOf(node.nodeId, edges);
  const down = downstreamOf(node.nodeId, edges);
  return (
    <li className={`dag-node state-${nr?.state ?? 'NONE'}`} id={`node-${node.nodeId}`}>
      <div className="dag-node-head">
        <span className="dag-index">{index + 1}</span>
        <strong className="mono">{node.nodeId}</strong>
        {node.title ? <span>{node.title}</span> : null}
        <code>
          {node.capability.type}@{node.capability.version}
        </code>
        {nr ? <StatusBadge value={nr.state} /> : <Badge tone="muted">not started</Badge>}
        {nr ? (
          <span className="small muted">
            attempt {nr.attempt}/{nr.maxAttempts}
            {nr.manualRetries
              ? ` · ${nr.manualRetries} manual retr${nr.manualRetries === 1 ? 'y' : 'ies'}`
              : ''}{' '}
            · {fmtDuration(nr.durationMs)}
            {nr.startedAt ? <> · started {fmtDateTime(nr.startedAt)}</> : null}
          </span>
        ) : null}
        {nr ? <NodeRunLink id={nr.id}>node run →</NodeRunLink> : null}
      </div>
      <div className="dag-edges">
        {up.length ? (
          <span>← {up.map((e) => `${e.from}${e.when ? ` [branch=${e.when.branch}]` : ''}`).join(', ')} </span>
        ) : (
          <span className="muted">entry node </span>
        )}
        {down.length ? (
          <span>→ {down.map((e) => `${e.to}${e.when ? ` [branch=${e.when.branch}]` : ''}`).join(', ')}</span>
        ) : null}
        <span className="muted">
          {' '}
          · queue {node.queue} · timeout {fmtDuration(node.timeoutMs)} · retry ×{node.retry.maxAttempts}
        </span>
      </div>
      {nr?.skipReason ? <p className="small muted">Skipped: {nr.skipReason}</p> : null}
      {nr?.error ? <ErrorBox error={nr.error} /> : null}
      {nr?.state === 'FAILED' ? (
        <ActionForm
          action={retryNodeRunAction}
          submitLabel="Retry failed node"
          inline
          confirmMessage={`Retry node ${node.nodeId}? The run re-opens.`}
          hidden={{ nodeRunId: nr.id, revalidate: path }}
        />
      ) : null}
      {nr?.wait ? (
        <div className="panel panel-warn small">
          <div>
            Waiting ({nr.wait.kind}) since <RelTime iso={nr.wait.since} />: {nr.wait.reason}
            {nr.wait.correlationKey ? (
              <>
                {' '}
                · correlation <code>{nr.wait.correlationKey}</code>
              </>
            ) : null}
            {nr.wait.timeoutAt ? (
              <>
                {' '}
                · times out <RelTime iso={nr.wait.timeoutAt} />
              </>
            ) : null}
          </div>
          {nr.wait.data ? <JsonView value={nr.wait.data} label="wait data" /> : null}
        </div>
      ) : null}
      {nr?.state === 'WAITING' ? (
        <details>
          <summary>Resume waiting node</summary>
          <ActionForm
            action={resumeNodeRunAction}
            submitLabel="Resume"
            hidden={{ nodeRunId: nr.id, revalidate: path }}
          >
            <label className="field">
              <span>Resume payload (JSON object)</span>
              <textarea name="payload" rows={5} defaultValue="{}" spellCheck={false} />
            </label>
          </ActionForm>
        </details>
      ) : null}
      <FanoutStats fanout={nr?.fanout} chunkStates={node.chunkStates} nodeRunId={nr?.id} />
      <div className="grid-2">
        <div>
          <JsonView value={node.config} label="config" />
          {nr ? (
            <JsonView value={nr.input} label={nr.inputTruncated ? 'input (truncated)' : 'input'} />
          ) : null}
        </div>
        <div>
          {nr?.outputRef ? (
            <div className="small">
              Output offloaded:{' '}
              <ArtifactLink id={nr.outputRef.artifactId}>artifact {nr.outputRef.artifactId}</ArtifactLink> (
              {nr.outputRef.mimeType}, {fmtBytes(nr.outputRef.size)})
            </div>
          ) : null}
          {nr?.outputPreview ? <TextBlock text={nr.outputPreview} label="output preview" /> : null}
          {nr && nr.output !== undefined ? <JsonView value={nr.output} label="output" /> : null}
        </div>
      </div>
      {nr?.attempts.length ? (
        <details>
          <summary>Attempts ({nr.attempts.length})</summary>
          <AttemptsTable attempts={nr.attempts} />
        </details>
      ) : null}
      {nr ? (
        <details open={nr.state === 'FAILED'}>
          <summary>Logs{logs ? ` (${logs.length})` : ''}</summary>
          <Logs logs={logs} />
        </details>
      ) : null}
      <span className="sr-only">Run {runId}</span>
    </li>
  );
}

export default async function RunDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const res = await apiGet<RunDetail>(`/api/runs/${seg(id)}`);
  if (!res.ok) {
    return (
      <>
        <PageHeader title="Run" />
        <ApiErrorPanel error={res.error} />
      </>
    );
  }
  const { run, version, nodes, children, artifacts } = res.data;
  const path = `/runs/${seg(run._id)}`;
  // Logs are only on the full node-run document; fetch them in parallel (best effort).
  const logResults = await Promise.all(
    nodes.map(async (n) => {
      if (!n.nodeRun) return [n.nodeId, undefined] as const;
      const r = await apiGet<NodeRun>(`/api/node-runs/${seg(n.nodeRun.id)}`);
      return [n.nodeId, r.ok ? r.data.logs : undefined] as const;
    }),
  );
  const logs = new Map(logResults);
  const ordered = topoOrder(nodes, (n) => n.nodeId, version.edges);
  const childTotal = Object.values(children).reduce((a, b) => a + b, 0);
  const t = run.trigger;

  return (
    <>
      <PageHeader
        title={
          <>
            Run <code>{run._id}</code>
          </>
        }
        subtitle={
          <>
            <WorkflowLink id={run.workflowKey} />
            <span>
              v{run.workflowVersion} ({version.title})
            </span>
            <StatusBadge value={run.state} />
            {run.cancelRequestedAt ? <Badge tone="warn">cancel requested</Badge> : null}
          </>
        }
        actions={
          !TERMINAL.has(run.state) ? (
            <ActionForm
              action={cancelRunAction}
              submitLabel="Cancel run"
              variant="danger"
              inline
              confirmMessage={`Cancel run ${run._id}? Running nodes are cancelled at the next checkpoint.`}
              hidden={{ runId: run._id, revalidate: path }}
            />
          ) : null
        }
      />

      <div className="grid-2">
        <Section title="Summary" id="summary">
          <KV
            items={[
              ['Workflow version', <code key="v">{version.id}</code>],
              [
                'Trigger',
                <span key="t">
                  {t.kind}
                  {t.actor ? ` by ${t.actor.kind}:${t.actor.id}` : ''}
                  {t.scheduleId ? (
                    <>
                      {' '}
                      · schedule <code>{t.scheduleId}</code>
                    </>
                  ) : null}
                  {t.scheduledFor ? <> · for {fmtDateTime(t.scheduledFor)}</> : null}
                  {t.event ? <> · event {t.event}</> : null}
                </span>,
              ],
              ['Created', <RelTime key="c" iso={run.createdAt} abs />],
              ['Started', <RelTime key="s" iso={run.startedAt} abs />],
              ['Finished', <RelTime key="f" iso={run.finishedAt} abs />],
              [
                'Duration',
                fmtDuration(
                  run.durationMs ??
                    (run.startedAt && !run.finishedAt
                      ? Date.now() - new Date(run.startedAt).getTime()
                      : undefined),
                ),
              ],
              ['Status', <StatusBadge key="st" value={run.state} />],
              run.failedNodeIds.length
                ? [
                    'Failed nodes',
                    run.failedNodeIds.map((n) => (
                      <a key={n} href={`#node-${n}`} className="label-chip mono">
                        {n}
                      </a>
                    )),
                  ]
                : null,
              [
                'Lineage',
                run.parent ? (
                  <>
                    child of <RunLink id={run.parent.runId} /> (node run{' '}
                    <NodeRunLink id={run.parent.nodeRunId} />
                    {run.parent.itemIndex !== undefined ? `, item #${run.parent.itemIndex}` : ''}) · depth{' '}
                    {run.depth} · root <RunLink id={run.rootRunId} />
                  </>
                ) : (
                  'top-level'
                ),
              ],
              run.idempotencyKey ? ['Idempotency key', <code key="ik">{run.idempotencyKey}</code>] : null,
              [
                'Labels',
                Object.keys(run.labels ?? {}).length ? (
                  <span>
                    {Object.entries(run.labels).map(([k, v]) => (
                      <span key={k} className="label-chip small">
                        {k}={k === 'sourceId' ? <SourceLink id={v} /> : v}
                      </span>
                    ))}
                  </span>
                ) : null,
              ],
              [
                'Capability versions',
                <JsonView key="cv" value={run.capabilityVersions} label="node → type@version" />,
              ],
            ]}
          />
        </Section>
        <Section title="Input / output" id="io">
          <JsonView value={run.input} label="input" open />
          {run.outputRef ? (
            <p className="small">
              Output offloaded to{' '}
              <ArtifactLink id={run.outputRef.artifactId}>artifact {run.outputRef.artifactId}</ArtifactLink> (
              {fmtBytes(run.outputRef.size)})
            </p>
          ) : null}
          {run.output !== undefined ? (
            <JsonView value={run.output} label="output" />
          ) : (
            <p className="small muted">No inline output.</p>
          )}
          <ErrorBox error={run.error} />
          <h3 style={{ marginTop: 10 }}>Child runs</h3>
          {childTotal ? (
            <p className="small">
              {childTotal} child run{childTotal === 1 ? '' : 's'}:{' '}
              {Object.entries(children).map(([state, n]) => (
                <span key={state} className="label-chip">
                  <StatusBadge value={state} /> {n}
                </span>
              ))}{' '}
              <Link href={`/runs?parentRunId=${seg(run._id)}&all=true`}>list →</Link>
            </p>
          ) : (
            <p className="empty">No child runs.</p>
          )}
        </Section>
      </div>

      <Section title={`Nodes (${nodes.length}, DAG order)`} id="nodes">
        <ol className="dag">
          {ordered.map((n, i) => (
            <NodeCard
              key={n.nodeId}
              node={n}
              index={i}
              edges={version.edges}
              runId={run._id}
              logs={logs.get(n.nodeId)}
              path={path}
            />
          ))}
        </ol>
      </Section>

      <Section
        title={`Artifacts (${artifacts.length})`}
        id="artifacts"
        description="Artifacts written during this run. Content is served as plain text (never rendered)."
      >
        <ArtifactsTable artifacts={artifacts} />
      </Section>
    </>
  );
}
