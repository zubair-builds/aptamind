# FE-6 — a `$ref` default resolves when the referenced node was skipped

Status: **Implemented on feat/market-waves-6-7 (PR #6)** (owner approved 2026-10-31).

## Problem

A workflow that branches cannot join its branches into one output. `core.switch` routes to one
branch; the nodes of the other branch end `SKIPPED`. A node after both branches (an edge from each,
which the graph already runs when either predecessor completes on its branch) cannot read the
skipped branch's output: `NodeOutputStore.load` throws `invalid_state` ("Output of node X is not
available (state SKIPPED)"), even when the input template gives the ref an explicit `default`.
`default` only applied to an `undefined` value, never to a skipped node.

Found in the PR #6 review: the UK sponsor import ends early on an unchanged file (wave 7). The
`finalize` node is skipped, so the run had no output (`run.output` undefined) and the import report
(`GET /api/imports/:id`, run views) was empty for every unchanged run.

## Why a market-only fix is not enough

Market declares workflows; it does not resolve their inputs. Ref resolution (`refs.ts`) and node
output loading (`outputs.ts`) live in `@aptamind/workflows`, which is frozen. Market alternatives
were worse: a second output node is impossible (`outputNode` is one id), and running `finalize` on
the unchanged path would need inputs (`parse`, `valid`, `companies`) that are themselves skipped.

## Packages affected

- `packages/workflows` (frozen): `outputs.ts` (`NodeSkippedError`), `refs.ts` (catch it when a
  default is given), new `refs.test.ts`.
- `packages/market`: `market.dataset_import_report@1` and the `report` node of
  `market.uk_sponsor_register.import` (`outputNode: report`) use it.

## Change

1. `NodeOutputStore.load` throws `NodeSkippedError` (a subclass of `InvalidStateError`, same code
   and message as before) when the node run is `SKIPPED`.
2. `resolveTemplate`: a `{ $ref, default }` leaf whose ref throws `NodeSkippedError` resolves to
   `default`. Without a `default` key the error propagates as before. Any other error (missing,
   failed, unsupported ref) still propagates even when a default is given.

## Compatibility

- Additive: before this change, every skipped-node ref failed the node. Only templates that both
  reference a node that can be skipped and give an explicit default change behaviour, and no
  existing workflow did (a node with a skipped predecessor-only path was itself skipped).
- Same error code and message for callers that do not pass a default; `NodeSkippedError` is an
  `InvalidStateError`.
- No schema, storage or API change. Existing workflow versions are unaffected.

## Tests

- `packages/workflows/src/refs.test.ts`: default on a skipped node resolves to the default; a
  skipped node without a default still fails (`NodeSkippedError`); a non-skip failure is not
  swallowed by a default.
- Market integration: `market.int.test.ts` and `uk-register-universe.int.test.ts` assert the
  unchanged run's output `{complete:true, unchanged:true, delistedCompanies:0, reconciled:0}`.
