import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
import { ApiErrorPanel } from '@/components/ApiError';
import { StatusBadge } from '@/components/Badge';
import { DataTable } from '@/components/DataTable';
import { JsonView, TextBlock } from '@/components/Json';
import { ArtifactLink, RunLink, WorkflowLink } from '@/components/links';
import { Pagination } from '@/components/Pagination';
import { AttemptsTable, ErrorBox, FanoutStats, Logs } from '@/components/RunParts';
import { KV, PageHeader, Section } from '@/components/Section';
import { RelTime } from '@/components/Time';
import { resumeNodeRunAction, retryNodeRunAction } from '@/lib/actions';
import { apiGet, seg } from '@/lib/api';
import { fmtBytes, fmtDateTime, fmtDuration, intParam } from '@/lib/format';
import type { FanoutChunk, NodeRun, Page } from '@/lib/types';

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }) {
  const { id } = await params;
  return { title: `Node run ${id}` };
}

export default async function NodeRunPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const p = await searchParams;
  const limit = intParam(p.limit, 50, 1, 200);
  const offset = intParam(p.offset, 0);
  const res = await apiGet<NodeRun>(`/api/node-runs/${seg(id)}`);
  if (!res.ok) {
    return (
      <>
        <PageHeader title="Node run" />
        <ApiErrorPanel error={res.error} />
      </>
    );
  }
  const nr = res.data;
  const path = `/node-runs/${seg(nr._id)}`;
  const chunks = nr.fanout
    ? await apiGet<Page<FanoutChunk>>(`/api/node-runs/${seg(nr._id)}/chunks`, { limit, offset })
    : null;

  return (
    <>
      <PageHeader
        title={
          <>
            Node <code>{nr.nodeId}</code>
          </>
        }
        subtitle={
          <>
            <Link href={`/runs/${seg(nr.runId)}#node-${nr.nodeId}`}>← Run {nr.runId}</Link>
            <WorkflowLink id={nr.workflowKey} />
            <code>
              {nr.capability.type}@{nr.capability.version}
            </code>
            <StatusBadge value={nr.state} />
          </>
        }
        actions={
          nr.state === 'FAILED' ? (
            <ActionForm
              action={retryNodeRunAction}
              submitLabel="Retry failed node"
              inline
              hidden={{ nodeRunId: nr._id, revalidate: path }}
            />
          ) : null
        }
      />
      <div className="grid-2">
        <Section title="Node run">
          <KV
            items={[
              ['Node run id', <code key="i">{nr._id}</code>],
              ['Run', <RunLink key="r" id={nr.runId} />],
              ['Root run', <RunLink key="rr" id={nr.rootRunId} />],
              ['Queue', <code key="q">{nr.queue}</code>],
              [
                'Attempt',
                `${nr.attempt} / ${nr.maxAttempts}${nr.manualRetries ? ` (+${nr.manualRetries} manual)` : ''}`,
              ],
              ['Resumes', nr.resumeCount],
              ['Started', <RelTime key="s" iso={nr.startedAt} abs />],
              ['Finished', <RelTime key="f" iso={nr.finishedAt} abs />],
              ['Duration', fmtDuration(nr.durationMs)],
              ['Dispatched', nr.dispatchedAt ? fmtDateTime(nr.dispatchedAt) : null],
              ['Next attempt', nr.nextAttemptAt ? <RelTime iso={nr.nextAttemptAt} abs /> : null],
              ['Lease', nr.leaseOwner ? `${nr.leaseOwner} until ${fmtDateTime(nr.leaseExpiresAt)}` : null],
              [
                'Idempotency key',
                <code key="ik" className="small">
                  {nr.idempotencyKey}
                </code>,
              ],
              ['Skip reason', nr.skipReason ?? null],
            ]}
          />
          <ErrorBox error={nr.error} />
          {nr.wait ? (
            <div className="panel panel-warn small">
              Waiting ({nr.wait.kind}) since <RelTime iso={nr.wait.since} />: {nr.wait.reason}
              {nr.wait.data ? <JsonView value={nr.wait.data} label="wait data" /> : null}
            </div>
          ) : null}
          {nr.state === 'WAITING' ? (
            <ActionForm
              action={resumeNodeRunAction}
              submitLabel="Resume"
              hidden={{ nodeRunId: nr._id, revalidate: path }}
            >
              <label className="field">
                <span>Resume payload (JSON object)</span>
                <textarea name="payload" rows={5} defaultValue="{}" spellCheck={false} />
              </label>
            </ActionForm>
          ) : null}
          {nr.resumePayload ? <JsonView value={nr.resumePayload} label="last resume payload" /> : null}
        </Section>
        <Section title="Input / output">
          <JsonView value={nr.input} label={nr.inputTruncated ? 'input (truncated)' : 'input'} />
          {nr.outputRef ? (
            <p className="small">
              Output offloaded:{' '}
              <ArtifactLink id={nr.outputRef.artifactId}>artifact {nr.outputRef.artifactId}</ArtifactLink> (
              {nr.outputRef.mimeType}, {fmtBytes(nr.outputRef.size)})
            </p>
          ) : null}
          {nr.outputPreview ? <TextBlock text={nr.outputPreview} label="output preview" /> : null}
          {nr.output !== undefined ? <JsonView value={nr.output} label="output" /> : null}
        </Section>
      </div>
      <Section title={`Attempts (${nr.attempts.length})`}>
        <AttemptsTable attempts={nr.attempts} />
      </Section>
      <Section title={`Logs (${nr.logs.length})`}>
        <Logs logs={nr.logs} max={2000} />
      </Section>
      {nr.fanout ? (
        <Section title="Fan-out chunks" id="chunks">
          <FanoutStats fanout={nr.fanout} chunkStates={{}} />
          {chunks && !chunks.ok ? <ApiErrorPanel error={chunks.error} /> : null}
          {chunks && chunks.ok ? (
            <>
              <DataTable
                caption="Chunks"
                rows={chunks.data.items}
                rowKey={(c) => c._id}
                columns={[
                  { key: 'i', header: 'Chunk', numeric: true, cell: (c) => c.index },
                  { key: 'start', header: 'Items from', numeric: true, cell: (c) => c.startIndex },
                  { key: 'state', header: 'State', cell: (c) => <StatusBadge value={c.state} /> },
                  { key: 'att', header: 'Attempt', numeric: true, cell: (c) => c.attempt },
                  {
                    key: 'res',
                    header: 'Results',
                    cell: (c) => {
                      const ok = c.results.filter((r) => r.status === 'succeeded').length;
                      const failed = c.results.length - ok;
                      return (
                        <span className="small">
                          {ok} ok{failed ? <span className="text-bad"> · {failed} failed</span> : null}
                        </span>
                      );
                    },
                  },
                  {
                    key: 'children',
                    header: 'Child runs',
                    cell: (c) => {
                      const ids = c.results.map((r) => r.childRunId).filter((x): x is string => !!x);
                      return ids.length ? (
                        <span className="small">
                          {ids.slice(0, 5).map((cid) => (
                            <span key={cid} className="label-chip">
                              <RunLink id={cid} />
                            </span>
                          ))}
                          {ids.length > 5 ? ` +${ids.length - 5}` : null}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      );
                    },
                  },
                  { key: 'started', header: 'Started', cell: (c) => <RelTime iso={c.startedAt} /> },
                  { key: 'fin', header: 'Finished', cell: (c) => <RelTime iso={c.finishedAt} /> },
                  {
                    key: 'errors',
                    header: 'Item errors / results',
                    cell: (c) =>
                      c.results.length ? (
                        <JsonView value={c.results} label="results" />
                      ) : (
                        <span className="muted">—</span>
                      ),
                  },
                ]}
              />
              <Pagination
                total={chunks.data.total}
                limit={limit}
                offset={offset}
                pathname={path}
                params={{}}
              />
            </>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
