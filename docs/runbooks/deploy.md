# Deploying a release (v0.1)

Aptamind v0.1 runs as API and worker processes over one MongoDB, Redis and object store. Most
releases can be rolled process by process. **Releases that change a closed MongoDB validator are
drain-first** (supervisor ruling, `docs/programme/DECISION_LOG.md` bf98d4d).

## Is this a validator-changing release?

Yes when the release bumps a number in `packages/professional/src/schema-versions.ts`
(`PROFESSIONAL_COLLECTION_VERSIONS`) or changes a Market/Foundation collection spec. The PR says
so, and lists any migration it adds to `packages/platform` `MIGRATIONS`.

## Drain-first procedure

**Mandatory for P1.1 → P1.2 (and any upgrade from a release before P1.2):** P1.1 processes do
not know collection versions, so a P1.1 process that restarts after P1.2 booted re-applies its
closed subjects validator (without `acquisitionCount`) and new uploads start failing. Every
P1.1 process must be stopped before the first P1.2 process starts.

1. Stop accepting work: scale the API to zero (or take it out of the load balancer) and stop
   every worker. Wait until no process of the old release is running.
2. Deploy the new release and start **one** process (API or worker). On boot it runs pending
   migrations under the migration lock, then applies the collection definitions.
   - Migrations that write a new field widen the validator themselves first.
   - A failed migration fails the boot; fix it before starting more processes. (Only a held
     migration lock is tolerated — the process then applies definitions directly and continues.)
   - If this first process logs `migration lock busy`, another process holds the migration lock:
     do not start more processes. Find the holder (`_locks` document `migrations`: `owner`,
     `expiresAt`). If it is still running, wait for it; if it died, the lock expires after
     10 minutes (`expiresAt`) — then restart this process so it runs the migrations itself.
     Never delete the lock while its owner may still be migrating.
3. Check the boot log for the applied migration ids and that `professional_schema_versions`
   holds the release's versions, then start the remaining processes.

## Safety nets (do not rely on them instead of draining)

- Versioned definitions: a process of an older release (P1.2 or later) that boots late skips any
  Professional collection whose recorded version is newer than its code (validator and indexes
  untouched), and logs a warning naming the skipped collections. It is a safety net, not a
  guarantee: the version read and the apply are not atomic, so an older and a newer process
  booting at the same moment can still interleave — drain-first is what rules that out. It does
  not cover releases before P1.2 at all (see above).
- Schema changes follow widen → backfill → tighten across releases
  (`docs/architecture/professional-domain.md` §15): a field becomes required only in a later
  release, after the backfill migration has run everywhere.

## Rollback

Skipping a newer collection skips **its indexes too**: a rolled-back process runs against the
newer release's indexes, and if its code relies on an index the newer release changed or
removed (idempotency and uniqueness rest on indexes), it runs without it. Therefore roll back
only when the target release's collection versions **equal** the recorded ones, or when the PR
that bumped a version documents that its index set is compatible with the previous version's
code. A release that tightened a field cannot be rolled back past the release that widened it
without restoring the widened validator first.
