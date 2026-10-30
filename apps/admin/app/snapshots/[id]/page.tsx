import Link from 'next/link';
import { ActionForm } from '@/components/ActionForm';
import { ApiErrorPanel } from '@/components/ApiError';
import { ArtifactLink, ExternalLink, RunLink, SourceLink } from '@/components/links';
import { KV, PageHeader, Section } from '@/components/Section';
import { RelTime } from '@/components/Time';
import { reprocessSnapshotAction } from '@/lib/actions';
import { apiGet, seg } from '@/lib/api';
import { fmtBytes } from '@/lib/format';
import type { Snapshot } from '@/lib/types';

type Params = Promise<{ id: string }>;

export const metadata = { title: 'Snapshot' };

export default async function SnapshotPage({ params }: { params: Params }) {
  const { id } = await params;
  const res = await apiGet<Snapshot>(`/api/snapshots/${seg(id)}`);
  if (!res.ok) {
    return (
      <>
        <PageHeader title="Snapshot" />
        <ApiErrorPanel error={res.error} />
      </>
    );
  }
  const s = res.data;
  return (
    <>
      <PageHeader
        title={`Snapshot ${s._id}`}
        subtitle={
          <>
            <Link href={`/sources/${seg(s.sourceId)}`}>← Source</Link>
          </>
        }
        actions={
          <ActionForm
            action={reprocessSnapshotAction}
            submitLabel="Reprocess"
            variant="primary"
            inline
            hidden={{ snapshotId: s._id, revalidate: `/snapshots/${seg(s._id)}` }}
          />
        }
      />
      <Section title="Snapshot">
        <KV
          items={[
            ['Source', <SourceLink key="s" id={s.sourceId} />],
            ['Via', s.via],
            ['URL', s.url ? <ExternalLink href={s.url} /> : null],
            ['HTTP status', s.httpStatus ?? null],
            ['Content type', s.contentType ?? s.artifact.mimeType],
            ['Items', s.itemCount ?? null],
            ['Content hash', <code key="h">{s.contentHash}</code>],
            ['First fetched', <RelTime key="f" iso={s.firstFetchedAt} abs />],
            ['Last fetched', <RelTime key="l" iso={s.lastFetchedAt} abs />],
            ['Fetch count', s.fetchCount],
            [
              'Artifact',
              <>
                <ArtifactLink id={s.artifact.artifactId} /> ({s.artifact.mimeType},{' '}
                {fmtBytes(s.artifact.size)}) ·{' '}
                <ArtifactLink id={s.artifact.artifactId} preview={200_000}>
                  preview first 200 KB
                </ArtifactLink>
              </>,
            ],
            ['sha256', <code key="sha">{s.artifact.sha256}</code>],
            [
              'Runs',
              s.runIds?.length ? (
                <span>
                  {s.runIds.map((r) => (
                    <span key={r} className="label-chip">
                      <RunLink id={r} />
                    </span>
                  ))}
                </span>
              ) : null,
            ],
          ]}
        />
      </Section>
    </>
  );
}
