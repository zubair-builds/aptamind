# FE-1 — `@aptamind/db` index sync misreads text indexes and races on drop

Status: **Approved; implementation under independent review** (PR #13). Raised by Review A of PR #10; promoted
from candidate when Review A of PR #12 showed the drop race also hits ordinary index-key changes,
which both Market M7 and Professional P1.1 make.

## Problem

`packages/db/src/collections.ts` `dropChangedIndexes` compares `listIndexes().key` with the spec
key. MongoDB reports a text index key as `{_fts: 'text', _ftsx: 1}`, which never equals the spec
(e.g. `{'identity.normalizedTitle': 'text'}`), so any text index is dropped and rebuilt on every
`ensureCollections` (every process boot). Separately, two processes booting together can both
decide to drop the same changed index; the loser's `dropIndex` fails with `IndexNotFound` (code 27)
and its `init()` throws.

## Why a stream-local solution is insufficient

Text indexes can be avoided stream-locally (Market now uses a token array), but the drop race cannot:
any deploy that changes an index key under an existing name — routine for every domain — can make
one of two concurrently booting processes (api + worker) fail `init()`. Working around it per stream
(renaming every changed index) would leave orphaned indexes and push a Foundation bug onto domains.

## Affected shared packages

`packages/db` (collection/index sync). All domains' `ensureReady` paths.

## Change

- Index keys are compared **in field order** (previously `canonical()` sorted keys, so a
  reordered key was never detected and `createIndexes` failed with `IndexKeySpecsConflict`).
- Text indexes are compared on the server's shape: the contiguous run of text fields collapses to
  `_fts: 'text', _ftsx: 1` at its first position; expected `weights` are 1 per text field
  overridden by `options.weights`; `default_language` (default `english`) and
  `language_override` (default `language`) are compared too. An unchanged text index (including
  wildcard `$**` with weights) is never dropped; any option change rebuilds it instead of failing.
- `IndexNotFound` on drop is treated as success.
- Drop-changed-then-create runs in a bounded retry loop (4 attempts, short backoff) that re-lists
  and re-compares on each attempt, retrying on `IndexBuildAborted` (276 — another process dropped
  the index mid-build), `IndexOptionsConflict` (85) and `IndexKeySpecsConflict` (86).

## Residual risk (documented, not solved here)

A process that listed the old definition can still drop the _new_ index after another process has
finished creating it; the index is then briefly missing until the late process recreates it. For
an ordinary index that is a short performance gap. For a **unique** index, duplicates could be
written in the gap and the recreate would then fail with `DuplicateKey`. Rule until a follow-up
lands: **never change the key or options of an existing unique index in place** — add a new index
under a new name, backfill/verify, then drop the old name in a later release. Follow-up candidate:
boot-time index lock document (FE-1b).

Mixed-version rolling deploys: the same index change must not be run by two different code
versions at once (an old and a new process holding different specs can drop each other's index
until one exhausts its retries). Roll index changes out so every booting process has the same spec.

## Compatibility / migration / test impact

Existing non-text indexes are untouched (the server preserves key order); a spec that reorders a
key's fields now converges by rebuilding instead of failing with `IndexKeySpecsConflict`; no data migration. Full Foundation regression
plus Market and Professional integration suites.

## Alternatives considered

Stream-local avoidance of text indexes (kept for Market search semantics, but does not fix the race);
renaming every changed index (rejected: orphaned indexes, pushes the bug to domains); a
per-collection opt-out flag (rejected: hides the bug).

## Evidence

`packages/testing/src/runtime/runtime-index-sync.int.test.ts` (CI runtime step, 7 cases): unchanged
text index never dropped (command monitoring); text field change rebuilds; each text option
(`weights`, `default_language`, `language_override`) change rebuilds instead of failing; wildcard
text index with weights not rebuilt; field-order changes detected (incl. a field moved across the
text part); three concurrent syncs on a changed key succeed; a drop fired while another process's
build is observed running (`$currentOp`, 150k documents) is survived via the retry loop. Mutations:
retry disabled → the mid-build test fails; weights comparison removed → two option tests fail;
pre-change code → the no-rebuild and race tests fail.
