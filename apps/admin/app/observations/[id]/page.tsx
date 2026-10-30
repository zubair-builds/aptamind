import Link from 'next/link';
import { ApiErrorPanel } from '@/components/ApiError';
import { Badge, StatusBadge } from '@/components/Badge';
import { JsonView } from '@/components/Json';
import { ArtifactLink, EntityLink, ReviewLink, RunLink, SnapshotLink, SourceLink } from '@/components/links';
import { KV, PageHeader, Section } from '@/components/Section';
import { RelTime } from '@/components/Time';
import { apiGet, seg } from '@/lib/api';
import { humanize } from '@/lib/format';
import type { ObservationDetail } from '@/lib/types';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { id } = await params;
  return { title: `Observation ${id}` };
}

export default async function ObservationPage({ params }: { params: Params }) {
  const { id } = await params;
  const res = await apiGet<ObservationDetail>(`/api/observations/${seg(id)}`);
  if (!res.ok) {
    return (
      <>
        <PageHeader title="Observation" />
        <ApiErrorPanel error={res.error} />
      </>
    );
  }
  const { observation: o, kind, source } = res.data;
  if (!o) {
    return (
      <>
        <PageHeader title="Observation" />
        <div className="panel panel-warn" role="alert">
          Observation <code>{id}</code> was not found.
        </div>
      </>
    );
  }
  const r = o.resolution;
  return (
    <>
      <PageHeader
        title={
          <>
            Observation <code>{o._id}</code>
          </>
        }
        subtitle={
          <>
            <Badge tone="muted">{kind ?? 'unknown'} observation</Badge>
            <StatusBadge value={r.state} />
            {r.entityId ? (
              <>
                resolved to <EntityLink kind={kind ?? 'company'} id={r.entityId} />
              </>
            ) : null}
          </>
        }
      />
      <div className="grid-2">
        <Section title="Provenance" id="provenance">
          <KV
            items={[
              [
                'Source',
                <>
                  <SourceLink id={o.sourceId}>{source?.name ?? o.sourceId}</SourceLink>
                  {source?.key ? <span className="muted mono small"> {source.key}</span> : null}
                </>,
              ],
              [
                'Authority',
                source?.authority?.tier ? <Badge tone="info">{humanize(source.authority.tier)}</Badge> : null,
              ],
              ['Snapshot', o.snapshotId ? <SnapshotLink id={o.snapshotId} /> : null],
              [
                'Raw artifact',
                o.artifactId ? (
                  <>
                    <ArtifactLink id={o.artifactId} /> ·{' '}
                    <ArtifactLink id={o.artifactId} preview={200_000}>
                      preview
                    </ArtifactLink>
                  </>
                ) : null,
              ],
              ['Locator', o.locator ? <code>{o.locator}</code> : null],
              ['External id', o.externalId ? <code>{o.externalId}</code> : null],
              ['Run', o.runId ? <RunLink id={o.runId} /> : null],
              ['Parser', `${o.parser.name}@${o.parser.version}`],
              ['AI', o.ai ? `${o.ai.provider} / ${o.ai.model} (prompt ${o.ai.promptVersion})` : null],
              [
                'Content hash',
                <code key="h" className="small">
                  {o.contentHash}
                </code>,
              ],
              ['First observed', <RelTime key="f" iso={o.firstObservedAt} abs />],
              ['Last observed', <RelTime key="l" iso={o.lastObservedAt} abs />],
              ['Seen count', o.seenCount],
              [
                'Warnings',
                o.warnings.length ? <span className="text-warn">{o.warnings.join('; ')}</span> : null,
              ],
            ]}
          />
        </Section>
        <Section title="Resolution" id="resolution">
          <KV
            items={[
              ['State', <StatusBadge key="s" value={r.state} />],
              ['Entity', r.entityId ? <EntityLink kind={kind ?? 'company'} id={r.entityId} /> : null],
              ['Method', r.method],
              ['Confidence', r.confidence ? <StatusBadge value={r.confidence} kind="confidence" /> : null],
              ['Review item', r.reviewItemId ? <ReviewLink id={r.reviewItemId} /> : null],
              ['Resolved', <RelTime key="r" iso={r.resolvedAt} abs />],
              ['Resolver version', r.resolverVersion],
              ['Error', r.error ? <span className="text-bad">{r.error}</span> : null],
            ]}
          />
        </Section>
      </div>
      <Section title="Payload (normalized statement)" id="payload">
        <JsonView value={o.payload} label="payload" open />
      </Section>
      <p className="small">
        <Link href={`/sources/${seg(o.sourceId)}`}>Source detail →</Link>
      </p>
    </>
  );
}
