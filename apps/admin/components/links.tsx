import Link from 'next/link';
import type { ReactNode } from 'react';

const e = encodeURIComponent;

export interface SourceSummary {
  name?: string;
  key?: string;
  authority?: { tier?: string };
}

/** Source id → summary. A Map, so ids such as `constructor` never read inherited properties. */
export type SourceNames = ReadonlyMap<string, SourceSummary>;

export function sourceNames(list: Array<SourceSummary & { _id: string }> | undefined): SourceNames {
  return new Map((list ?? []).map((s) => [s._id, s]));
}

export function Id({ id }: { id: string }) {
  return <code className="id">{id}</code>;
}

export function SourceLink({
  id,
  names,
  children,
}: {
  id: string | null | undefined;
  names?: SourceNames;
  children?: ReactNode;
}) {
  if (!id) return <span className="muted">—</span>;
  const s = names?.get(id);
  return (
    <Link href={`/sources/${e(id)}`} title={id}>
      {children ?? s?.name ?? s?.key ?? id}
    </Link>
  );
}

export function RunLink({ id, children }: { id: string | null | undefined; children?: ReactNode }) {
  if (!id) return <span className="muted">—</span>;
  return (
    <Link href={`/runs/${e(id)}`} className="mono">
      {children ?? id}
    </Link>
  );
}

export function NodeRunLink({ id, children }: { id: string | null | undefined; children?: ReactNode }) {
  if (!id) return <span className="muted">—</span>;
  return (
    <Link href={`/node-runs/${e(id)}`} className="mono">
      {children ?? id}
    </Link>
  );
}

export function WorkflowLink({ id, children }: { id: string | null | undefined; children?: ReactNode }) {
  if (!id) return <span className="muted">—</span>;
  return (
    <Link href={`/workflows/${e(id)}`} className="mono">
      {children ?? id}
    </Link>
  );
}

export function CompanyLink({ id, children }: { id: string | null | undefined; children?: ReactNode }) {
  if (!id) return <span className="muted">—</span>;
  return <Link href={`/companies/${e(id)}`}>{children ?? <code className="id">{id}</code>}</Link>;
}

export function JobLink({ id, children }: { id: string | null | undefined; children?: ReactNode }) {
  if (!id) return <span className="muted">—</span>;
  return <Link href={`/jobs/${e(id)}`}>{children ?? <code className="id">{id}</code>}</Link>;
}

export function ObservationLink({ id, children }: { id: string | null | undefined; children?: ReactNode }) {
  if (!id) return <span className="muted">—</span>;
  return (
    <Link href={`/observations/${e(id)}`} className="mono">
      {children ?? id}
    </Link>
  );
}

export function SnapshotLink({ id, children }: { id: string | null | undefined; children?: ReactNode }) {
  if (!id) return <span className="muted">—</span>;
  return (
    <Link href={`/snapshots/${e(id)}`} className="mono">
      {children ?? id}
    </Link>
  );
}

export function ReviewLink({ id, children }: { id: string | null | undefined; children?: ReactNode }) {
  if (!id) return <span className="muted">—</span>;
  return (
    <Link href={`/review/${e(id)}`} className="mono">
      {children ?? id}
    </Link>
  );
}

/**
 * Artifact content is served by the admin's own route handler as text/plain + nosniff, so
 * third-party HTML is never rendered. A plain <a> (not <Link>) because it is not a page.
 */
export function ArtifactLink({
  id,
  children,
  preview,
}: {
  id: string | null | undefined;
  children?: ReactNode;
  preview?: number;
}) {
  if (!id) return <span className="muted">—</span>;
  const href = `/artifacts/${e(id)}${preview ? `?preview=${preview}` : ''}`;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="mono">
      {children ?? id}
    </a>
  );
}

export function ExternalLink({ href, children }: { href: string | null | undefined; children?: ReactNode }) {
  if (!href) return <span className="muted">—</span>;
  const safe = /^https?:\/\//i.test(href);
  if (!safe) return <span className="mono">{href}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="ext">
      {children ?? href}
    </a>
  );
}

export function EntityLink({ kind, id }: { kind: string; id: string }) {
  switch (kind) {
    case 'company':
      return <CompanyLink id={id} />;
    case 'job':
      return <JobLink id={id} />;
    case 'source':
      return <SourceLink id={id} />;
    case 'observation':
      return <ObservationLink id={id} />;
    case 'run':
      return <RunLink id={id} />;
    default:
      return <Id id={id} />;
  }
}
