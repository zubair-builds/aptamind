# Contract: Market companies (list, detail, actions)

Owner: Market. Consumer: Admin UX (company list and company record). Status: **v2.3 (M11.5)** = v1
(`d9799b6`) + strict query validation and DTOs (M7.1) + list v2 and the summary view (M7.2) +
record sub-resources and run history (M7.6); later items are marked with their PR. **v2.2 (M8.4)**: NL IND
licences (`register` `nl_ind_recognised_sponsors`, `country` `NL`) and the `nl_kvk` external id; no
field changes. **v2.3 (M11.5)**: `employment.sponsorship.history[]` / `historyCountries` (additive),
the `us_h1b_employer` external id (a row key), and history rows left out of `quality.*`.

Changelog: **v2.1** — M7.6 sub-resources (`/api/companies/:id/{observations,jobs,sources,audit,runs}`),
summary `factsHash`, `count=exact` refused on the semi-join fallback (> 10 000 ids), version-pin
wording (`rev`, `contentHash`). **v2** — M7.2 (with the PR #10 fixes). Shared conventions and Fact semantics:
[market-provenance](market-provenance.md). Code: `apps/admin/lib/api-server/routes/entities.ts`,
`packages/market/src/companies/company.service.ts`, schema `companyDocSchema` in
`packages/market/src/companies/company.schema.ts`.

## GET /api/companies — list (v2, M7.2)

List v2 conventions (sort, `after`/`nextCursor`, `count`, `view`, multi-value and date
parameters) are in [market-provenance § List v2](market-provenance.md#list-v2-conventions-m72m75).
Code: `packages/market/src/api/companies.ts` (`companyListQuerySchema`, `listCompanies`).

| Query                               | Type / values                                                              | Semantics                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit`, `offset`, `after`, `count` | see conventions                                                            | `after` is the previous page's `nextCursor`; it cannot be combined with `offset`.                                                                                                                                                                                                                                                 |
| `view`                              | `full` (default) \| `summary`                                              | `summary`: the row shape below (no evidence).                                                                                                                                                                                                                                                                                     |
| `sort`                              | `name` (default), `createdAt`, `lastChangedAt`; `-` prefix = descending    | `identity.normalizedName`, `createdAt`, `freshness.lastChangedAt` (missing values sort first ascending, last descending). Always tie-broken on `_id`.                                                                                                                                                                             |
| `q`                                 | string (1–200)                                                             | **Anchored prefix** (M7.2) on the strict name key, any alias's strict key, or — when `q` has no spaces — the domain (`https://www.acme.com/jobs` → `acme.com`). Case, punctuation and legal form are ignored for names. **Breaking vs v1:** v1 matched substrings of the strict name key; a word inside a name no longer matches. |
| `sponsorCountry`                    | ISO-2 list, case-insensitive (`GB` or `GB,IE`)                             | Any of them in `employment.sponsorship.licenceCountries` (currently **listed** licences only).                                                                                                                                                                                                                                    |
| `careersStatus`                     | list of `not_attempted \| found \| not_found \| failed \| website_unknown` | `freshness.careersDiscoveryStatus` is any of them.                                                                                                                                                                                                                                                                                |
| `licenceStatus`                     | list of `licensed \| previously_licensed \| none`                          | `employment.sponsorship.capability.value`; `none` = no capability known (null). Company capability only, never role sponsorship.                                                                                                                                                                                                  |
| `hasDomain`                         | `true \| false`                                                            | `identity.domain.value` is set / is null.                                                                                                                                                                                                                                                                                         |
| `hasConflicts`                      | `true \| false`                                                            | ≥ 1 / no entry in `quality.conflictFields`. **v2 change:** `false` now means "no conflicts" (v1 ignored `false`).                                                                                                                                                                                                                 |
| `hasActiveJobs`                     | `true \| false`                                                            | **Live:** the company has / has no job with `status: active` and a state other than `CLOSED`.                                                                                                                                                                                                                                     |
| `hasOpenReviews`                    | `true \| false`                                                            | **Live:** an open review item names the company as its entity or as a candidate (like the summary's `openReviewCount`; unlike the full document's `quality.openReviewCount` snapshot).                                                                                                                                            |
| `sourceId`                          | id list                                                                    | Any of them in `quality.sourceIds` (sources that contributed an observation). History registers (the H-1B source) are **not** counted: their rows do not enter `quality.*` (M11.5).                                                                                                                                               |
| `changedAfter`, `changedBefore`     | date or ISO date-time                                                      | `freshness.lastChangedAt` in [after, before). Companies never changed have no value and never match.                                                                                                                                                                                                                              |
| `createdAfter`, `createdBefore`     | date or ISO date-time                                                      | `createdAt` in [after, before).                                                                                                                                                                                                                                                                                                   |

Always filtered to `status: 'active'` (merged companies are hidden). All filters combine with AND;
values inside one list parameter combine with OR.

Response `ListPage` = `{ items, total: number | null, limit, offset, nextCursor: string | null }`:

- `view=full` (default): items are full `CompanyDoc`s, exactly as v1 (DTO
  `companyListFullResponseDto`). v1 clients that read `items/total/limit/offset` are unaffected.
- `view=summary`: items are `CompanySummary` rows (DTO `companySummaryDto`, strict; each row
  ≤ `SUMMARY_ROW_MAX` = 3 KB of JSON):

```ts
CompanySummary = {
  _id, status: 'active' | 'merged', mergedInto?,
  identity: { displayName: SummaryFact<string>, legalName: SummaryFact<string>, normalizedName: string,
              domain: SummaryFact<string>, website: SummaryFact<string>, aliases: string[] /* ≤ 20 names */ },
  geography: { headquarters: SummaryFact<Location> },
  employment: { careersUrls: SummaryFact<string[]>, ats: SummaryFact<{provider, boardToken}[]>,
                sponsorship: { capability: SummaryFact<'licensed' | 'previously_licensed'>, licenceCountries: string[] } },
  quality: { observationCount, sourceCount, conflictFields: string[] },
  freshness: { careersDiscoveryStatus, careersCheckedAt?, lastChangedAt?, lastReconciledAt? },
  activeJobCount: number,   // live count of active, non-CLOSED jobs (not a snapshot)
  openReviewCount: number,  // live count of open review items naming it (entity or candidate)
  rev: number,              // revision of the reconciled state (0 before the first fenced write)
  contentHash: string | null, // reconciliation.contentHash; null until the first reconciliation
  factsHash: string,        // summary-row pin (drift detection): sha-256 over every summary fact's value, status, confidence
  createdAt, updatedAt,
}
SummaryFact<T> = { value: T | null, status: 'known' | 'unknown' | 'conflicting',
                   confidence: { level: 'high' | 'medium' | 'low' | 'unknown', score? },
                   basis: string | null,   // confidence.reasons[0], ≤ 100 chars (… when cut); null when none
                   alternates: number }    // other values the fact retained (conflicts[] minus `overridden by operator` system readings, PR #21)
```

`SummaryFact` is the cross-domain summary convention (`INTEGRATION_CONTRACTS.md` § Summary
convention): Professional read APIs use the same shape. The summary paths match the full document
(`identity.displayName.value` works for both), minus evidence and the conflicting values. Render
`status` and `confidence.level` exactly as for a full Fact (provenance contract); `alternates > 0`
means the record has `conflicts[]` to show; open the record for evidence.

**Version pins:** `factsHash` is the summary-row pin: it changes whenever a summary fact changes
value, status or confidence, is always present, and detects drift only (no endpoint returns an
older version). Company `rev` is the revision of the reconciled state (every reconciler write and
every merge into the company advances it; unlike job `rev`, which counts lifecycle/source-ref
writes only). `rev` + `contentHash` identify a reconciled state only once the company has been
reconciled: `contentHash` is `null` before the first reconciliation (a company created by
resolution but not yet reconciled), so a pin must not rely on it.

**Breaking vs the first M7.2 summary (unreleased):** `quality.openReviewCount` (a snapshot taken at
the last reconciliation) is replaced by the live top-level `openReviewCount`. The full document
(`view=full`) still has `quality.openReviewCount`; it is a reconciliation-time snapshot, use the
summary or `hasOpenReviews` for live state.

Performance notes: every sort and the default filters are index-backed (`by_status_name`,
`list_created`, `list_changed`, `by_domain`, `by_alias`, `by_source_ids`). `hasActiveJobs` and `hasOpenReviews` are driven from the small side: the ids of companies with an
active job (`by_company_state`) or named by an open review item (`by_entity`, `by_candidate`) are
read first and the list filters `_id` in / not in them. Above 10 000 such ids the filter falls
back to a per-row lookup in sort order (matches are then dense). With either filter `count`
defaults to `none` (pass `count=exact` for a total; in the per-row fallback, above 10 000 ids,
`count=exact` is refused with 400 `validation_failed`, `details.param: 'count'`).

States: loading; empty (no companies, or no filter match); error (see conventions). There is no
partial state.

## GET /api/companies/:id — detail

`?view=summary` (M7.2) returns exactly one `CompanySummary` list row of the requested document
(the peek-panel shape, DTO `companySummaryDto`), with no related lists. Any other query parameter
is a 400.

Response without `view` (DTO `companyDetailResponseDto`):

```ts
{
  company: CompanyDoc;                 // the requested document, even if merged
  survivor: CompanyDoc | null;         // set when company.status === 'merged' (follows mergedInto, ≤10 hops;
                                       // a cycle, longer or broken chain is 409, never a merged "survivor")
  observations: CompanyObservationDoc[]; // resolved to the survivor, newest lastObservedAt first, ≤100
                                         // includes superseded versions (check `superseded`)
  observationSources: { _id, key, name, authority }[];
  jobs: JobDoc[];                      // survivor's active jobs, ≤100, newest lastSeenAt first; no description text
  jobSources: SourceDoc[];             // sources with companyId = survivor, ≤50
  reviews: ReviewItemDoc[];            // ALL statuses, entity or candidate = survivor, ≤50
  audit: AuditEventDoc[];              // entity company = survivor, newest first, ≤50
}
```

Rendering rules:

- **Merged**: when `survivor` is not null, show a "merged into" banner linking to
  `survivor._id`. Related lists are always the survivor's.
- **Facts**: render each Fact with its status, confidence and conflicts, and evidence on demand
  (provenance contract). Group them as: identity (`displayName`, `legalName`, `aliases[]`,
  `domain`, `website`, `externalIds[]`); classification; firmographics (usually `unknown`: no
  productised source yet); geography (`headquarters`, `offices[]`, `registeredLocations[]`);
  employment (`careersUrls`, `ats`, `remotePolicy`, `relocationSupport`, sponsorship).
- **Sponsor licences**: `employment.sponsorship.licences[] { register, country, route, typeRating,
status: listed|no_longer_listed, firstSeenAt, lastSeenAt, evidence[] }`. `no_longer_listed`
  means absent from the latest **complete** import. It is not a revocation claim. Registers
  (M8.4, `market.sponsorRegister`): `uk_home_office_licensed_sponsors_workers` (GB; `route` is the
  register's own label, `typeRating` e.g. "Worker (A rating)") and `nl_ind_recognised_sponsors`
  (NL; `route` one of the canonical labels in `market.registerRoute`, `typeRating` null). A licence
  is capability for its own `country` only: show the country with every licence, never as a
  company-wide "sponsors" badge. `licenceCountries` lists the countries of **listed** licences.
  Attribution (show on the licence evidence or a source footnote): UK — "Contains public sector
  information licensed under the Open Government Licence v3.0" (Home Office, GOV.UK); NL —
  "Source: IND public register of recognised sponsors (ind.nl)". Sources and format:
  [market-sources § Sponsor registers](market-sources.md#sponsor-registers-register-adapters-m84).
- **External ids**: `identity.externalIds[] { namespace, id }` (`market.identityNamespace`):
  `uk_sponsor_register` (the UK register's row key, name + town), `nl_kvk` (the Dutch KvK
  number the IND register lists, 8 digits) and `us_h1b_employer` (the H-1B Data Hub employer key,
  `<strict name>|<state>`, listed once a history row attached). It is a **row key**, not an
  identifier: it is not an identity key and never attaches a later row by itself.
- **Sponsorship hiring history (M11.5)**: `employment.sponsorship.history[] { register, country,
route, fiscalYear, initialApprovals, initialDenials, continuingApprovals, continuingDenials,
rows, evidence[] }` — one entry per register, route and fiscal year, summed over the register
  rows attached to the company (each row once, whatever source carried it). The latest complete
  import of a fiscal year replaces that source's earlier rows of the year. History rows do not
  count in `quality.observationCount`, `quality.sourceIds` or `quality.lastObservedAt` (they do
  not refresh the company). `historyCountries` = countries with at least one approval. Today only
  `us_uscis_h1b_employer_data_hub` / `US` / `H-1B`. **History, not capability:** it never
  changes `capability`, `licences` or `licenceCountries`; render it as "H-1B petitions approved
  in FY… (USCIS)" under the label "Sponsorship history", never "Sponsored before", "sponsors" or
  "licensed". Denials alone are listed but give no history
  country. Absent on documents reconciled before M11.5 (treat as `[]`). Attribution: "Source:
  U.S. Citizenship and Immigration Services, H-1B Employer Data Hub (uscis.gov)".
- `identity.distinctFrom[]`: companies an operator declared distinct. Show them as "not the same
  as …".
- `organization.*` and `classification.schemes` are empty seams. Hide them when empty.

Errors: 404 `not_found` for an unknown id; 409 `conflict` when a merged company's `mergedInto`
chain cycles, exceeds 10 hops or is broken (`details.reason: cycle | too_long | broken`), on the
detail and every sub-resource.

The embedded lists above are first pages. Page further with the record sub-resources below
(M7.6). Gap: the field explanation trace → **M12.4**.

## Company record sub-resources (M7.6, Admin ask API-5)

Every tab of the company record pages independently with the list v2 parameters (`limit`,
`after` → `nextCursor`, `offset`, `count`; [conventions](market-provenance.md#list-v2-conventions-m72m75)).
They follow merges: for a merged company they return the **survivor's** data (as the detail's
related lists do). 404 for an unknown id; unknown parameters are 400. Code:
`packages/market/src/api/activity.ts`.

| Endpoint                              | Query                                                          | Items (order)                                                                                                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/companies/:id/observations` | paging, `current=true\|false`, `sourceId` (id list)            | `CompanyObservationDoc & { current: boolean }`, newest `lastObservedAt` first; `current` = not superseded (the version reconciliation reads); `current=false` = history only. The page adds `sources: {_id, key, name, authority}[]` for its rows. DTO `companyObservationsResponseDto`. |
| `GET /api/companies/:id/jobs`         | every `GET /api/jobs` v2 parameter except `companyId` (400)    | the jobs list v2 scoped to the company (`view=summary`, sorts, filters). DTOs as `/api/jobs`.                                                                                                                                                                                            |
| `GET /api/companies/:id/sources`      | every `GET /api/sources` v2 parameter except `companyId` (400) | the sources list v2 scoped to the company (with `freshnessState`). DTOs as `/api/sources`.                                                                                                                                                                                               |
| `GET /api/companies/:id/audit`        | paging                                                         | `AuditEventDoc`, newest `at` first. DTO `auditPageResponseDto`.                                                                                                                                                                                                                          |
| `GET /api/companies/:id/runs`         | paging, `state` (run-state list), `workflowKey` (list)         | `EntityRun`, newest `createdAt` first (see below). DTO `entityRunsResponseDto`.                                                                                                                                                                                                          |

Company run history (no runtime change) = runs labelled `companyId` with the company **or a
company merged into it** (manual careers discovery), plus the runs that wrote its observations
(`runId`, `seenRunIds`: register imports, careers discovery children, …) and its audit events:

```ts
EntityRun = RunSummary & {   // runtime run without input/output (market-runs contract)
  linkedBy: ('label' | 'observation' | 'verification' | 'audit')[];  // why it is in this history
}
```

The run-id part is bounded (2 000 most relevant ids); labelled runs are unbounded.

## Actions

| Action           | Request                                       | Response                              | Notes                                                                                                                                                                                                   |
| ---------------- | --------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reconcile        | `POST /api/companies/:id/reconcile` (no body) | 200 `{ companyId, changed: boolean }` | Synchronous recompute from current observations. Idempotent. 409 `conflict` after 10 concurrent revision conflicts; retry later. 404 for an unknown id.                                                 |
| Discover careers | `POST /api/companies/:id/discover-careers`    | 202 `{ runId }`                       | Starts `market.company.discover_careers` (labels `companyId`). Outcome in the run's `discover` node output: `{status, careersUrl, ats[], pagesFetched}`. The company is updated when the run completes. |

Neither action needs a confirmation dialog: both are non-destructive. Company corrections and
merges happen **only through review items** ([market-review](market-review.md)). There is no
direct edit endpoint, by design (Law A: canonical values come from observations and
reconciliation).

## Provenance and confidence semantics specific to companies

- Authority defaults, overridden per field: the display name prefers the company's own site; the
  legal name prefers the registry. Operator corrections (`identity.domain`, `identity.website`,
  `identity.displayName`) enter as `operator` observations and win.
- Resolution never auto-merges risky cases. Possible duplicates appear as `company_duplicate` or
  `company_resolution` review items in `reviews`.
- `website_unknown` means "we have no official domain". Discovery never guesses one. Planned
  sources (M8.1 directory import, M8.3 Wikidata) add domains as observations with their own
  authority.
