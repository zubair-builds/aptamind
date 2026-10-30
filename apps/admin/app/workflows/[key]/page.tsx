import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
import { ApiErrorPanel } from '@/components/ApiError';
import { Badge } from '@/components/Badge';
import { JsonView } from '@/components/Json';
import { SchedulesTable } from '@/components/SchedulesTable';
import { KV, PageHeader, Section } from '@/components/Section';
import { RunsTable } from '@/components/tables';
import { RelTime } from '@/components/Time';
import { startWorkflowRunAction } from '@/lib/actions';
import { apiGet, seg } from '@/lib/api';
import { downstreamOf, topoOrder, upstreamOf } from '@/lib/dag';
import { fmtDuration } from '@/lib/format';
import type { Schedule, WorkflowDefinition, WorkflowDetail, WorkflowVersion } from '@/lib/types';

type Params = Promise<{ key: string }>;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export async function generateMetadata({ params }: { params: Params }) {
  const { key } = await params;
  return { title: `Workflow ${safeDecode(key)}` };
}

/** Read-only, readable representation of a workflow version: nodes in topological order + edges. */
function VersionGraph({ v }: { v: WorkflowVersion }) {
  const ordered = topoOrder(v.nodes, (n) => n.id, v.edges);
  return (
    <>
      <ol className="dag" aria-label={`Nodes of ${v.workflowKey} v${v.version} in topological order`}>
        {ordered.map((n, i) => {
          const up = upstreamOf(n.id, v.edges);
          const down = downstreamOf(n.id, v.edges);
          return (
            <li key={n.id} className="dag-node">
              <div className="dag-node-head">
                <span className="dag-index">{i + 1}</span>
                <strong className="mono">{n.id}</strong>
                {n.title ? <span>{n.title}</span> : null}
                <Link
                  href={`/capabilities#${encodeURIComponent(`${n.capability.type}@${n.capability.version}`)}`}
                >
                  <code>
                    {n.capability.type}@{n.capability.version}
                  </code>
                </Link>
                <Badge tone="muted">queue {n.queue}</Badge>
                <span className="small muted">
                  retry ×{n.retry.maxAttempts} (backoff {fmtDuration(n.retry.backoffMs)}–
                  {fmtDuration(n.retry.maxBackoffMs)}) · timeout {fmtDuration(n.timeoutMs)}
                </span>
                {v.outputNode === n.id ? <Badge tone="info">output node</Badge> : null}
              </div>
              <div className="dag-edges">
                {up.length ? (
                  <div>
                    ← after{' '}
                    {up.map((e, j) => (
                      <span key={`${e.from}-${j}`} className="label-chip">
                        <code>{e.from}</code>
                        {e.when ? (
                          <>
                            {' '}
                            when branch = <code>{e.when.branch}</code>
                          </>
                        ) : null}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="muted">entry node (no upstream)</div>
                )}
                {down.length ? (
                  <div>
                    → then{' '}
                    {down.map((e, j) => (
                      <span key={`${e.to}-${j}`} className="label-chip">
                        <code>{e.to}</code>
                        {e.when ? (
                          <>
                            {' '}
                            if branch = <code>{e.when.branch}</code>
                          </>
                        ) : null}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              {Object.keys(n.config ?? {}).length ? (
                <JsonView value={n.config} label="config" />
              ) : (
                <div className="small muted">config: {'{}'}</div>
              )}
              {n.input !== undefined ? <JsonView value={n.input} label="input mapping" /> : null}
            </li>
          );
        })}
      </ol>
      <details>
        <summary>Edges ({v.edges.length})</summary>
        {v.edges.length ? (
          <table className="table">
            <caption className="sr-only">Edges</caption>
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">Condition</th>
              </tr>
            </thead>
            <tbody>
              {v.edges.map((e, i) => (
                <tr key={i}>
                  <td className="mono">{e.from}</td>
                  <td className="mono">{e.to}</td>
                  <td>
                    {e.when ? <code>branch = {e.when.branch}</code> : <span className="muted">always</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">Single-node workflow.</p>
        )}
      </details>
    </>
  );
}

export default async function WorkflowDetailPage({ params }: { params: Params }) {
  const { key: rawKey } = await params;
  const key = safeDecode(rawKey);
  const [res, defs, schedules] = await Promise.all([
    apiGet<WorkflowDetail>(`/api/workflows/${seg(key)}`),
    apiGet<{ items: WorkflowDefinition[] }>('/api/workflows'),
    apiGet<{ items: Schedule[] }>('/api/schedules'),
  ]);
  const def = defs.ok ? defs.data.items.find((d) => d._id === key) : undefined;
  const path = `/workflows/${seg(key)}`;
  if (!res.ok) {
    return (
      <>
        <PageHeader title={key} />
        <ApiErrorPanel error={res.error} />
      </>
    );
  }
  const versions = [...res.data.versions].sort((a, b) => b.version - a.version);
  const latest = versions[0];
  const mySchedules = schedules.ok ? schedules.data.items.filter((s) => s.workflowKey === key) : [];

  return (
    <>
      <PageHeader
        title={def?.title ?? latest?.title ?? key}
        subtitle={
          <>
            <code>{key}</code>
            {latest ? <Badge tone="info">latest v{latest.version}</Badge> : null}
            {def?.archived ? <Badge tone="muted">archived</Badge> : null}
          </>
        }
      />
      {def?.description || latest?.description ? <p>{def?.description || latest?.description}</p> : null}
      {versions.length === 0 ? (
        <div className="panel panel-warn">No versions registered for this workflow key.</div>
      ) : null}

      <div className="grid-2">
        <Section title="Run now" id="run">
          <ActionForm
            action={startWorkflowRunAction}
            submitLabel="Start run"
            variant="primary"
            hidden={{ workflowKey: key, revalidate: path }}
          >
            <label className="field">
              <span>Input (JSON object)</span>
              <textarea name="input" rows={8} defaultValue="{}" spellCheck={false} />
            </label>
            <div className="actions-bar">
              <label className="field">
                <span>Version</span>
                <select name="version" defaultValue="">
                  <option value="">latest</option>
                  {versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Idempotency key (optional)</span>
                <input type="text" name="idempotencyKey" />
              </label>
            </div>
          </ActionForm>
          {latest?.inputSchema ? (
            <JsonView value={latest.inputSchema} label="Input JSON Schema (latest)" />
          ) : null}
        </Section>
        <Section title="Schedules" id="schedules">
          {schedules.ok ? (
            <SchedulesTable schedules={mySchedules} revalidate={path} />
          ) : (
            <ApiErrorPanel error={schedules.error} />
          )}
        </Section>
      </div>

      {versions.map((v, i) => (
        <Section
          key={v._id}
          id={`v${v.version}`}
          title={
            <>
              Version {v.version} {i === 0 ? <Badge tone="info">latest</Badge> : null}
            </>
          }
        >
          <KV
            items={[
              ['Title', v.title],
              ['Registered', <RelTime key="c" iso={v.createdAt} abs />],
              [
                'Content hash',
                <code key="h" className="small">
                  {v.contentHash}
                </code>,
              ],
              ['Nodes / edges', `${v.nodes.length} / ${v.edges.length}`],
              ['Output node', v.outputNode ? <code>{v.outputNode}</code> : null],
              Object.keys(v.labels ?? {}).length
                ? ['Labels', <JsonView key="l" value={v.labels} label="labels" />]
                : null,
            ]}
          />
          {i === 0 ? (
            <VersionGraph v={v} />
          ) : (
            <details>
              <summary>Show graph</summary>
              <VersionGraph v={v} />
            </details>
          )}
        </Section>
      ))}

      <Section
        title="Recent runs"
        id="runs"
        actions={
          <Link href={`/runs?workflowKey=${seg(key)}&all=true`} className="small">
            All runs →
          </Link>
        }
      >
        <RunsTable runs={res.data.runs} showWorkflow={false} />
      </Section>
    </>
  );
}
