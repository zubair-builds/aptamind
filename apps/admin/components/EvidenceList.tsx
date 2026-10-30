import type { Evidence } from '@/lib/types';
import { Badge } from './Badge';
import { ArtifactLink, ObservationLink, SnapshotLink, SourceLink, type SourceNames } from './links';
import { RelTime } from './Time';

/** Table of evidence references: source → observation → artifact, with locator and quote. */
export function EvidenceList({
  evidence,
  sources,
  caption = 'Evidence',
}: {
  evidence: Evidence[];
  sources?: SourceNames;
  caption?: string;
}) {
  if (!evidence.length) return <p className="empty">No evidence recorded.</p>;
  return (
    <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="table table-evidence">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Authority</th>
            <th scope="col">Observed</th>
            <th scope="col">Observation</th>
            <th scope="col">Artifact / snapshot</th>
            <th scope="col">Locator</th>
            <th scope="col">Quote</th>
          </tr>
        </thead>
        <tbody>
          {evidence.map((ev, i) => (
            <tr key={`${ev.sourceId}-${ev.observationId ?? ''}-${i}`}>
              <td>
                <SourceLink id={ev.sourceId} names={sources} />
              </td>
              <td>
                {ev.authority ? (
                  <Badge tone="info">{ev.authority.replace(/_/g, ' ')}</Badge>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                <RelTime iso={ev.observedAt} />
              </td>
              <td>
                <ObservationLink id={ev.observationId} />
              </td>
              <td>
                {ev.artifactId ? <ArtifactLink id={ev.artifactId}>artifact</ArtifactLink> : null}
                {ev.artifactId && ev.snapshotId ? ' · ' : null}
                {ev.snapshotId ? <SnapshotLink id={ev.snapshotId}>snapshot</SnapshotLink> : null}
                {!ev.artifactId && !ev.snapshotId ? <span className="muted">—</span> : null}
              </td>
              <td className="mono small">{ev.locator ?? <span className="muted">—</span>}</td>
              <td className="quote">
                {ev.quote ? <q>{ev.quote}</q> : <span className="muted">—</span>}
                {ev.extractor ? (
                  <div className="muted small">
                    via {ev.extractor.name}@{ev.extractor.version}
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
