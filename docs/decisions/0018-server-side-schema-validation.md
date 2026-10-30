# ADR-0018: Server-side schema validators derived from the Zod schemas

- Status: Accepted
- Date: 2026-09-27 (market foundation hardening, audit finding M-3)

## Context

ADR-0004 chose the official driver with Zod instead of an ODM. Zod validates what the code
parses, but raw `$set` updates, scripts and future bugs can write documents that no longer
match the declared shape, and most collections had no MongoDB validator.

## Decision

- `defineCollection` derives a MongoDB `$jsonSchema` validator from the collection's Zod
  schema by default (`zodToMongoJsonSchema`), and `ensureCollections` applies it with
  `validationLevel: moderate` and the default `validationAction: error`. Every insert, and
  every update of a document that is already valid, is checked. Documents that predate the
  validator and do not match it can still be updated, so rolling it out needs no migration
  window.
- The derived validator is structural: BSON types, required fields, enums and literals,
  nested objects and array items. Unknown extra fields are allowed, because documents evolve
  additively, and refinements (string lengths, regexes, ranges) stay in Zod.
- Inserts in the stores and domain services are also parsed with the Zod schema before
  writing, so application errors are reported with field paths before the server rejects them.
- A collection can opt out (`validator: false`) or supply its own validator.

## Consequences

- One source of truth: changing a Zod schema changes the server validator at the next
  `pnpm db:migrate`.
- An invalid write is rejected by MongoDB even when it bypasses the TypeScript types. This
  is covered for real documents in 11 collections by `schema-validation.int.test.ts`.
- Additive fields need no migration. A new required field needs a backfill before the
  validator is applied.
