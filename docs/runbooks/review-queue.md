# Runbook: review queue

Open items are ordered by priority (severity + boost) then age. The dashboard shows the backlog
by type and the age of the oldest item.

| Type                  | Typical cause                                                                                                       | Usual resolution                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `company_resolution`  | Candidate matches an existing company only weakly (fuzzy/loose name, same name in another town, conflicting domain) | `merge` into the right candidate, `create_new` for a genuinely different company, or `reject` bad data |
| `company_duplicate`   | Two companies claim the same domain/external id                                                                     | `merge` (older survives) or `keep_separate`                                                            |
| `job_duplicate`       | Same company/title/location with moderately similar description                                                     | `merge` or `keep_separate`                                                                             |
| `field_conflict`      | Equal-authority sources disagree (e.g. official domain), or third-party copies disagree with the official job       | `confirm` canonical value or `correct`                                                                 |
| `employment_conflict` | Interpretation raised a high-severity flag                                                                          | `confirm`, `correct` (job override), or `retry` after a logic fix                                      |
| `salary_suspicious`   | Salary ambiguous/malformed                                                                                          | `correct` with a structured value, or `confirm`/`dismiss`                                              |
| `parser_failure`      | Provider response could not be parsed                                                                               | fix adapter, then `retry`                                                                              |
| `source_anomaly`      | Dataset shrank / listing suddenly empty                                                                             | inspect snapshot; `retry` or `confirm`                                                                 |
| `careers_discovery`   | Several ATS boards found, or a board already belongs to another company                                             | `confirm`/`dismiss`; fix sources if needed                                                             |

Every decision requires a reason, is applied through the domain services, and is written to
`market_audit_events` (actor = `unauthenticated-internal-operator` until auth exists). Decisions
are retained as evaluation data. `correct` fields: jobs — `workModel`, `remoteScope`,
`sponsorship`, `relocation`, `compensation`, `employmentType` (value must match the contract
shape); companies — `identity.domain`, `identity.website`, `identity.displayName`.
