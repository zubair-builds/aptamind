# FE-P6 — generic artifact routes refuse private-domain (Professional) artifacts

Status: **Approved** (supervisor, 2026-09-29, `DECISION_LOG.md`); implemented on branch
`professional/fe-p6-artifact-guard`, cut from `main` — required before Professional P1.2.
Requirement: context doc R-4; domain doc §13.

## Problem

`apps/admin/lib/api-server/routes/ops.ts` serves any artifact by id: `GET /api/artifacts/:id` returns its
metadata (MIME type, size, sha256, first-writer context) and `GET /api/artifacts/:id/content`
returns its bytes. From P1.2, Professional stores CVs, LinkedIn exports, certificates and other
personal documents as artifacts. Anyone able to call the internal API with an artifact id — ids
appear in snapshot references, run outputs and logs — could read a subject's documents without
the subject check that Professional's own content route will perform
(`GET /api/professional/snapshots/:id/content`). The run view `GET /api/runs/:id`
(`apps/admin/lib/api-server/routes/workflows.ts`) also lists a run's artifact refs (id, storage key, size,
sha256), which confirms an artifact exists and what it hashes to. R-4 requires that Professional
artifacts are served **only** through Professional routes.

## Why a stream-local solution is insufficient

The generic routes live in the shared API bootstrap, not in the Professional route module, and
they are the leak. Professional cannot keep bytes out of the `ArtifactStore` (it is the only
content-addressed store; FE-P2 would be needed for a separate one), and it cannot change what the
generic routes serve from its own package. Content addressing also means ownership is not a
property of the stored bytes alone: identical bytes may be written by Market first and by
Professional later (the first writer's context wins in the `artifacts` document).

## Affected shared code

- `apps/admin/lib/api-server/routes/ops.ts` (composition layer): the two artifact routes consult a guard
  before returning metadata or bytes. Behaviour change for restricted artifacts only.
- `apps/admin/lib/api-server/routes/workflows.ts` (composition layer): `GET /api/runs/:id` filters the run's
  artifact refs through the guard. The data still comes from the frozen
  `packages/workflows` queries (`getRunDetail` → `listByRun`), which are unchanged.
- `packages/platform/src/index.ts` (composition root): new `ArtifactAccessGuard` on `Platform`
  (`artifactAccess.isRestricted(artifact)`, `artifactAccess.listableRunArtifacts(run, refs)`),
  assembled from the domains (today: Professional).
- `packages/professional` (stream-owned): `ownsArtifact()`, `ownsWorkflow()`,
  `referencedArtifactIds()`; `privacy/artifacts.ts`; index
  `professional_extractions.by_text_artifact`.

**No frozen package changes.** `@aptamind/storage` (`ArtifactStore`, `artifacts` collection),
`@aptamind/contracts` and `@aptamind/workflows` are untouched; the check uses the existing generic
`context` (`labels`, `workflowKey`) of an artifact document and Professional's own collections.

## Proposed change (implemented)

1. An artifact is **restricted** when either holds:
   - its stored context carries the Professional label `labels.domain = 'professional'` (from
     P1.2 every Professional `ArtifactStore.put` must pass `PROFESSIONAL_ARTIFACT_LABELS`; P1.2
     acceptance), or
   - the workflow runtime wrote it for a Professional workflow: `context.workflowKey` starts with
     `professional.` (node-output spills in `packages/workflows/src/outputs.ts`, record sets from
     `createRecordAccess`, generic `core.*` http/browser/artifact nodes — none carry the label or
     a Professional reference), or
   - a Professional document references it: `professional_snapshots.artifact.artifactId` (index
     `by_artifact`) or `professional_extractions.textArtifact.artifactId` (new partial index
     `by_text_artifact`).
     The reference check covers content-addressed sharing (bytes first stored by another writer).
2. `Platform.artifactAccess` wires `isRestricted` to `professional.ownsArtifact`. The generic
   routes import no domain package (`pnpm check:arch` unchanged).
3. A restricted artifact is answered **exactly like an unknown id**: `404`, `{ error: { code:
'not_found', message: 'Artifact <id> not found', details: { entity: 'Artifact', id } } }`, on
   both routes and for every `preview` value — no existence oracle. The check runs before any byte
   is read. A guard failure (database error) is a 500 and serves nothing (fails closed).
4. `GET /api/runs/:id` lists **no** artifact refs for a Professional run
   (`workflowKey` starts with `professional.`), and for any other run omits refs a Professional
   document references (one batched `$in` lookup per collection over at most 50 refs). The rest
   of the run detail is unchanged. A guard failure is a 500 (fails closed).
5. Non-restricted artifacts are served exactly as before (JSON metadata; content as
   `text/plain; charset=utf-8` for textual types, `application/octet-stream` otherwise, with
   `x-artifact-mime-type`, `x-content-type-options: nosniff`,
   `content-security-policy: default-src 'none'`).

## Compatibility impact

- Market and runtime artifacts: unchanged (no Market artifact carries the Professional label, a
  `professional.*` workflow key, or a Professional reference). Admin's artifact viewer and run
  view keep working for them; for a Professional run the run view shows an empty artifact list.
- Fail-closed edge: if Market and Professional store byte-identical content, the shared artifact
  becomes unavailable on the generic routes for Market too. Accepted: personal documents and
  public job/registry data practically never coincide, and serving personal data is the worse
  failure. The Market bytes remain readable by Market code through `ArtifactStore`.
- Timing: a restricted id costs one or two indexed lookups more than an unknown id. The API is
  internal (ADR-0008); ids are 128-bit hashes of content, not enumerable.
- Workflow runtime and capabilities read artifacts through `ArtifactStore` directly and are
  unaffected.
- Out of scope (recorded, not changed here): the run view filters only its `artifacts` list —
  `run.outputRef`, each node's `outputRef` and `outputPreview` (first 2 KB) on `GET /api/runs/:id`,
  and the other generic run views (`/api/runs`, `/api/node-runs/:id`, chunks) still show
  Professional runs' node inputs/outputs, which may embed artifact refs (whose bytes are refused
  by the workflow-key rule). Tracked as programme follow-up `FE-P7` (restrict generic run views for
  private domains). Professional workflows must keep personal values out of node outputs
  (domain doc §13); a wider restriction of generic run views for private domains would be its
  own exception.
- Correlation labels: the runtime copies every `*Id` run label (e.g. `subjectId`, `sourceId`)
  onto the artifacts it writes, which conflicts with §13 "labels carry no subject id". P1.2 must
  write Professional artifacts directly through `ArtifactStore` with
  `PROFESSIONAL_ARTIFACT_LABELS` (or amend §13); recorded as P1.2 acceptance.

## Migration impact

None. The new Professional index is created by `ensureProfessionalCollections`, which runs in the
Professional collections migration and in `professional.ensureReady()` on every boot. No data is
rewritten.

## Test impact

`apps/admin/lib/api-server/artifact-guard.int.test.ts` (runs in the CI "Market and API integration" step):
Market HTML and binary artifacts served as before (status, JSON metadata, content type, `nosniff`,
CSP, MIME header, preview); a Professional-labelled artifact and unlabelled artifacts referenced by
a Professional snapshot and by an extraction's text, and an unlabelled artifact the runtime wrote
for a `professional.*` workflow, are refused on both routes (and with `?preview`) with a
response byte-identical (modulo id) to an unknown id, and `readBytes` is never called for them;
`GET /api/runs/:id` is identical to the runtime query for a Market run, drops a ref once a
Professional snapshot references it, and lists no refs for a Professional run; a failing
ownership check is a 500 that serves
neither metadata nor bytes (fail closed); unknown ids unchanged. Unit
(`packages/professional/src/privacy/artifacts.test.ts`): label and workflow-key rules; label and
workflow-key decide without a lookup; `ownsArtifact` rejects (fails closed) when either
reference lookup rejects. Mutation: removing the guard, the label check, the workflow-key check,
either reference lookup, the run-view omission or filter, or reading bytes before the guard each
fails the suite.
Full chain plus `apps`, `packages/market` and `packages/professional` integration suites.

## Alternatives considered

- **Label check only** (`context.labels.domain`): rejected alone — the first writer's context
  decides under content addressing, so bytes first stored by another writer would leak. Kept as
  the fast path and to cover the window between `put` and the snapshot insert.
- **Key/namespace prefix per domain in `ArtifactStore`** (e.g. `artifacts/professional/…`):
  requires changing the frozen `@aptamind/storage` (ids and storage keys are content hashes) and
  breaks cross-writer deduplication; rejected.
- **Owner field on the `artifacts` document**: a frozen-package schema change with the same
  first-writer problem; rejected.
- **Generic routes importing `@aptamind/professional`**: violates the layering rule (shared code
  never imports a domain); rejected.
- **Removing the generic content route**: breaks Admin's Market artifact viewer; rejected.
