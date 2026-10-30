# ADR-0019: Source chronology is separate from processing chronology

- Status: Accepted
- Date: 2026-09-28 (final repair pass, audit finding M-5)

## Context

Observations recorded one timestamp, `lastObservedAt`, which moved whenever content was
(re)processed. Company observation supersession ("which version of a source record is current")
used it. An independent re-audit showed that reprocessing an older snapshot after a newer one
made the old content current again and regressed the canonical company. The sponsor register's
delisting marker had the same flaw: it was the import run's start time, so reprocessing an older
register snapshot delisted sponsors that only the newer snapshot lists.

## Decision

- Observations carry `sourceObservedAt`: when the source was fetched and found to contain the
  content. It is the fetch time of the snapshot the observation came from (the recording time
  when there is no snapshot). Reprocessing reuses the snapshot's fetch time; only a genuinely
  later fetch of the same content moves it forward (`$max`). `lastObservedAt` remains processing
  time.
- Supersession orders versions of a source record by `(sourceObservedAt, _id)`. Fact recency,
  evidence `observedAt` and licence seen-dates use source chronology.
- The complete-import delisting marker is the imported snapshot's source time and only moves
  forward.
- Snapshots are content-addressed per source, so the source time of a snapshot is its latest
  fetch (`lastFetchedAt`), which only fetching changes — never reprocessing. This makes a
  genuine A → B → A change of source content current again.

## Consequences

- Replaying or reprocessing old data can refresh processing metadata but never makes old source
  content newer than later source content.
- Documents written before the field existed fall back to `lastObservedAt`.
- Permanent regressions: old-snapshot replay, A → B → A re-fetch, concurrent older/newer
  processing, deterministic ties (`company-reconcile-scale.int.test.ts`), and register
  reprocessing after a newer complete import (`market.int.test.ts`).
