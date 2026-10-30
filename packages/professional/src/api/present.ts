import type { ExtractionDoc } from '../extraction/extraction.schema';
import type { ObservationDoc } from '../observations/observation.schema';
import type { SnapshotDoc } from '../sources/source.schema';

/**
 * API presentation of snapshots (supervisor ruling, P1.2 re-verify): content hashes are
 * sensitive — a hash of low-entropy content (a GB/visa questionnaire) is effectively the value,
 * recoverable offline. So `contentHash` and the content-addressed `artifact`
 * (`artifactId`, `sha256`, `size`) are returned only with `include=sensitive`, and the artifact's
 * `storageKey` (content-addressed in the shared bucket) never.
 */
export type PresentedSnapshot<T extends SnapshotDoc> = Omit<T, 'contentHash' | 'artifact'> & {
  contentHash?: string;
  artifact?: Omit<SnapshotDoc['artifact'], 'storageKey'>;
};

export function presentSnapshot<T extends SnapshotDoc>(
  s: T,
  includeSensitive: boolean,
): PresentedSnapshot<T> {
  const { contentHash, artifact, ...rest } = s;
  if (!includeSensitive) return rest;
  const { storageKey: _key, ...visible } = artifact;
  void _key;
  return { ...rest, contentHash, artifact: visible };
}

export function presentSnapshots<T extends SnapshotDoc>(
  list: readonly T[],
  includeSensitive: boolean,
): PresentedSnapshot<T>[] {
  return list.map((s) => presentSnapshot(s, includeSensitive));
}

/**
 * API presentation of observations: `evidence.artifactId` is content-addressed (`art_<sha256
 * prefix>` of the whole snapshot, sensitive fields included), so it is the same oracle as the
 * snapshot's `contentHash` and is returned only with `include=sensitive`.
 */
export type PresentedObservation = Omit<ObservationDoc, 'evidence'> & {
  evidence: Omit<ObservationDoc['evidence'], 'artifactId'> & { artifactId?: string };
};

export function presentObservation(o: ObservationDoc, includeSensitive: boolean): PresentedObservation {
  if (includeSensitive) return o;
  const { artifactId: _artifact, ...evidence } = o.evidence;
  void _artifact;
  return { ...o, evidence };
}

export function presentObservations(
  list: readonly ObservationDoc[],
  includeSensitive: boolean,
): PresentedObservation[] {
  return list.map((o) => presentObservation(o, includeSensitive));
}

/**
 * API presentation of extractions (supervisor ruling M-3, before P2.1): the normalized-text
 * artifact (`textArtifact`, content-addressed) and each section's content `hash` are hash
 * oracles of the document text, so they are returned only with `include=sensitive` (the
 * artifact's `storageKey` never). Offsets, classes, status and counts stay.
 */
export type PresentedExtraction = Omit<ExtractionDoc, 'textArtifact' | 'sections'> & {
  textArtifact?: Omit<NonNullable<ExtractionDoc['textArtifact']>, 'storageKey'>;
  sections: Array<Omit<ExtractionDoc['sections'][number], 'hash'> & { hash?: string }>;
};

export function presentExtraction(e: ExtractionDoc, includeSensitive: boolean): PresentedExtraction {
  const { textArtifact, sections, ...rest } = e;
  if (!includeSensitive)
    return {
      ...rest,
      sections: sections.map(({ hash: _hash, ...section }) => {
        void _hash;
        return section;
      }),
    };
  if (!textArtifact) return { ...rest, sections };
  const { storageKey: _key, ...visible } = textArtifact;
  void _key;
  return { ...rest, textArtifact: visible, sections };
}

export function presentExtractions(
  list: readonly ExtractionDoc[],
  includeSensitive: boolean,
): PresentedExtraction[] {
  return list.map((e) => presentExtraction(e, includeSensitive));
}
