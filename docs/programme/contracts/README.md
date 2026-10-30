# UI/API contracts

One file per Admin-facing surface, named `<domain>-<surface>.md` (e.g. `market-company-list.md`,
`professional-profile-detail.md`), written by the owning domain stream. Each states: endpoint /
query, schema (by source path), states, actions, error states, permission assumptions, and
provenance/confidence semantics. Admin UX implements presentation from these; it never derives
domain truth.
