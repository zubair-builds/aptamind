# FE-4 — reference-counted delete of artifact bytes

Status: **Implemented on foundation/fe-4-artifact-delete** (owner approved 2026-10-30).
Depends on OPS-3 release marks (`expiredAt` on `market_snapshots`).

## Problem

OPS-3 can mark a market snapshot released, but nothing can remove the raw bytes. `ArtifactStore`
and `ObjectStorage` had no delete. The bytes live in object storage under a content-addressed key
(`artifacts/sha256/<aa>/<bb>/<hash>`), and the same hash is one artifact document shared by every
snapshot, source and domain that stored those bytes.

A bucket lifecycle rule would delete that object for everyone, including a snapshot that is still
live. Deleting the Mongo document would also drop the provenance record that names the artifact.

## Why a local fix is insufficient

The bytes and the artifact document are owned by `@aptamind/storage`, which is frozen. Market can
see which snapshots and other market records still need an artifact. It cannot remove the object
or stamp the artifact document without a seam in the store. A market-only flag would leave the
object in the bucket, and a later read could still return it.

## Affected packages

- `packages/storage` (frozen): `ObjectStorage.delete` and `ArtifactStore.deleteBytes`.
- `packages/market`: the reference check, `RetentionService.purgeReleased`, snapshot
  `bytesDeletedAt`, and a purge node on `market.retention.sweep`.
- No Professional code. Market does not query Professional collections (domains do not import
  each other).

## Change

1. **Object storage.** `ObjectStorage` gains `delete(key)`. `S3ObjectStorage` sends
   `DeleteObject`. A missing key is success, including an S3-compatible 404 (`NotFound` /
   `NoSuchKey`). `MemoryObjectStorage` deletes the map entry and ignores a missing key.
2. **Artifact document.** Optional `deletedAt`. The document is never removed. `get` still
   returns it. `readBytes` / `readText` / `readJson` throw `ArtifactDeletedError` (an
   `InvalidStateError`, code `invalid_state`, reason `bytes_deleted`) when `deletedAt` is set,
   before any object read, including when the caller already has `storageKey` and `sha256`.
3. **`ArtifactStore.deleteBytes(artifactId, referenced)`.** The caller supplies the reference
   check. The store invokes it immediately before the object delete. Results are `deleted`,
   `referenced` or `missing`. A second call is a no-op (`deleted`) and still tolerates a missing
   object. A missing document is `missing` and does not throw.
4. **`ArtifactStore.put`.** Identical bytes normally skip the upload when the document exists.
   If that document has `deletedAt`, or the object is missing, `put` uploads again (even when a
   leftover object is still there) and clears `deletedAt`. The reference id does not change.
5. **`RetentionService.purgeReleased({ limit, dryRun })`.** Candidates are distinct artifact ids
   on snapshots with `expiredAt` and no `bytesDeletedAt`, oldest release first. The default
   limit is 500.

   Bytes are deleted only when every market snapshot with that artifact id has `expiredAt` and
   none is pinned, and no other market field that stores an artifact id still cites it. That
   includes open review evidence and `context.reportArtifactId`, company and job observations
   (including superseded), imports, job verifications, job `content.descriptionArtifactId` and
   fact evidence, company evidence, signal evidence, and audit
   `details.boardArtifactId`.

   `market_job_evidence`, signal evidence and canonical facts cite `snapshotId`. A snapshot any
   of them cites is held (`job_evidence`, `signal_evidence`, `canonical_fact`), and so is one
   held for any other hold reason. The purge re-checks `holdReason` for every snapshot that
   shares the artifact immediately before delete. A closed or dismissed review does not keep
   bytes. The same check runs again inside `deleteBytes`, so a refetch that cleared `expiredAt`,
   or a release that was reverted, wins. Dry-run returns counts and writes nothing. The return
   value is `{ scanned, deletable, deleted, keptReferenced, dryRun }`. After a delete, those
   released snapshots get `bytesDeletedAt`. Recording the same bytes again (`recordSnapshot` →
   `put`) clears `expiredAt` and `bytesDeletedAt` and restores the object.

6. **Workflow.** `market.retention.sweep` gains a `purge` node (`market.retention_purge` v1)
   after `sweep`, input `{ limit: 500 }`. The edge is sweep → purge, so a failed sweep does not
   purge. The node is on the daily schedule (enabled, no separate flag).

## Compatibility

- `ObjectStorage` implementors must provide `delete`. The only ones are `S3ObjectStorage` and
  `MemoryObjectStorage`.
- `deletedAt` and `bytesDeletedAt` are optional. Old documents stay valid. Schema versions stay
  at 1, as with the OPS-3 optional snapshot fields.
- A read of a deleted artifact now fails with `ArtifactDeletedError` instead of returning bytes.
  Callers that already handle `AppError` see `invalid_state`.
- `put` of bytes whose document is marked deleted uploads again. `put` of live bytes is unchanged.
- Boot registers a new `market.retention.sweep` version because the spec hash changes. The run
  output of that workflow is now the purge node (the single sink). No admin reader of the old
  sweep output was found. The schedule does not pin `workflowVersion`, so the next fire uses the
  latest version.

## Migration

No records are deleted and nothing is backfilled. `bytesDeletedAt` stays absent until a purge
runs. Validators pick up the new optional fields on boot (`collMod` for collections that already
exist). The next daily retention fire uses the new workflow version after the worker boots.

## Tests

- `packages/storage/src/object-storage.test.ts`: in-memory `delete` removes the object; a second
  delete and a missing key do nothing.
- `packages/storage/src/artifact-store.test.ts`: a true reference check does not delete; a false
  one deletes the object, keeps the document and stamps `deletedAt`; `readBytes` throws
  `ArtifactDeletedError` even if different bytes are written back to the key; a second delete is
  a no-op; a missing object still marks the document and the read stays the typed error; a
  missing id returns `missing`; `put` of the same bytes after a delete overwrites leftover
  bytes, clears `deletedAt` and reads back the original.
- `packages/storage/src/artifact-store.int.test.ts`: the same delete, read error, idempotent
  second delete and `put` restore against MongoDB and S3 `DeleteObject`.
- `packages/market/src/retention-purge.int.test.ts`: no delete while any snapshot of the same
  artifact is unreleased (two sources, one object); no delete when pinned; no delete when an
  open review cites the artifact (evidence or `reportArtifactId`); a dismissed review does not
  keep bytes; dry-run counts and deletes nothing; a second purge is a no-op; a refetch after
  purge restores the bytes. Further cases lock observations, imports, job
  `descriptionArtifactId`, company fact evidence, verifications, board-liveness audit and
  signals. A snapshot cited by job evidence, signal evidence or a canonical fact is not deleted
  even when `expiredAt` is set. A release that was reverted is not deleted.

## Alternatives

- **Bucket lifecycle on the artifact prefix.** Rejected. The key is the hash. One rule would
  delete bytes a live snapshot, or another domain, still uses. OPS-3 already says expiry is
  application-controlled for that reason.
- **Delete the artifact document.** Rejected. Provenance has to keep naming the artifact after
  the bytes are gone. `get` still returns the document.
- **Delete when every snapshot is released, and ignore other collections.** Rejected. That is
  the owner minimum, and the implementation does at least that. Observations, imports, canonical
  facts, verifications, signals and the board-creation audit also store artifact ids. Deleting
  under those pointers would dangle them. The stricter check is why an import, a superseded
  observation or an append-only signal keeps the bytes for as long as that document exists.
- **A claim token around the delete.** Rejected for this change. The reference check runs twice,
  the second time immediately before `DeleteObject`. A narrower race remains (see notes). A
  token would be more machinery than the failure is worth.

## Implementation notes

- The re-check is the `referenced` callback inside `deleteBytes`, called after the document is
  loaded and before the object delete. Purge passes its own hold check there. That check re-reads
  `expiredAt` and `holdReason` for every snapshot of the artifact, so a refetch that cleared
  `expiredAt`, or a revert that cleared it or left a hold in place, is seen.
- Residual race, accepted: a refetch's `put` can skip the upload because the object still exists
  and `deletedAt` is not set yet, then purge deletes the object, then `recordSnapshot` clears
  `expiredAt`. The snapshot looks live and the bytes are gone until something stores them again.
  `put` uploads whenever `deletedAt` is set, even if an object remains, so a delete that has
  already been stamped is healed by the next store.
- `market_job_evidence` has `snapshotId` and no `artifactId`. The hold-reason re-check covers it,
  together with signal evidence and canonical-fact snapshot citations. A closed review does not.
- The purge limit counts artifact ids considered, including ones kept because a sibling snapshot
  or another document is still live. Those stay at the front of the candidate set every day.
  There is no purge cursor. A large set of always-referenced released artifacts can starve later
  ones until they drop out of the limit. Accepted for this version; the daily cap is 500.
- A missing artifact document is not counted as deleted. The released snapshots are still marked
  `bytesDeletedAt` so the sweep does not select them forever.
- Content-addressed ids are `art_<sha256[:32]>` across domains (FE-P8). Market does not read
  Professional collections. A hash that Market purges is the same object Professional would read.
  That cross-domain delete is a residual of FE-P8, not something this change queries around.
- Indexes: `market_snapshots` `by_artifact` on `artifact.artifactId`, and partial `by_released`
  on `{ expiredAt: 1, _id: 1 }` where `expiredAt` exists. A partial index cannot express
  "no `bytesDeletedAt`"; the query filters that.
