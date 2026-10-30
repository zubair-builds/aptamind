# Contract: Market provenance, confidence and API conventions (shared by all market-* contracts)

Owner: Market stream. Consumer: Admin UX. Status: **v1.2 (PR #21)**: v1.1 (M7.1: v1 `d9799b6`
plus strict query validation, published response DTOs and the operator-evidence fix) plus the
M11.1 employment semantics, role-axis-only sponsorship overrides and the `conflictFields`
definition (changelog at the end). Planned changes are
marked with their PR id (see [`../streams/market.md`](../streams/market.md)).

## Conventions (every Market endpoint)

| Topic         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base          | Internal Fastify API (`apps/admin`), JSON. There are no Market-specific prefixes: `/api/companies`, `/api/jobs`, `/api/sources`, `/api/review`, … These paths are stable.                                                                                                                                                                                                                                                                                                                  |
| Auth          | **None** (ADR-0008). Every request acts as `internal-operator` / `unauthenticated-internal-operator` (`packages/contracts/src/request-context.ts`). Private network only. The UI must not add permission logic. When auth arrives, only `apps/admin/lib/api-server/request-context.ts` changes.                                                                                                                                                                                            |
| Dates         | Stored as BSON dates and serialised as ISO-8601 strings.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| IDs           | Opaque prefixed strings (`cmp_…`, `job_…`, `src_…`, `rev_…`, `cobs_…` company observation, `jobs_…` job observation, `snap_…`, `aud_…`, `ver_…`). Never parse them. The one exception is documented at `GET /api/observations/:id`. Run ids belong to the runtime.                                                                                                                                                                                                                         |
| Pagination    | `limit` (1–200, default 50) and `offset` (0–100 000, default 0). v1 responses are `Page<T>` = `{ items, total, limit, offset }`. List v2 endpoints add keyset pagination (`after` → `nextCursor`), `count` and `sort` (additive; see [List v2 conventions](#list-v2-conventions-m72m75)).                                                                                                                                                                                                  |
| Errors        | `{ error: { code, message, details?, issues?, requestId? } }` (`apps/admin/lib/api-server/errors.ts`). `validation_failed` 400 (zod `issues` ≤ 20), `unsafe_url` 400, `not_found` 404, `conflict` 409, `invalid_state` 409, `limit_exceeded` 413, `unavailable` 503, `internal` 500 (has `requestId`). Every response carries `x-request-id`.                                                                                                                                              |
| Filters       | **Validated (M7.1).** Every query string is parsed by a strict schema (`packages/market/src/api/query.ts`): an unknown or misspelt parameter name, a misspelt enum value, a bad boolean (`true`/`false` only), an ISO-2 country that is not two letters, or an out-of-range `limit`/`offset` is a **400 `validation_failed`** with zod `issues` (never an empty page). Country codes are case-insensitive (`gb` = `GB`). Detail and action routes accept no query parameters (400 on any). |
| Async work    | Endpoints that start a workflow return **202** `{ runId }`. The effect is visible once the run completes (`GET /api/runs/:id`; see [market-runs](market-runs.md)).                                                                                                                                                                                                                                                                                                                         |
| No derivation | The UI renders values as returned. It must not infer business facts (for example remote status from a location string, or sponsorship from a licence).                                                                                                                                                                                                                                                                                                                                     |
| Response DTOs | Every response has a zod DTO in its JSON wire form (dates as ISO strings) in `packages/market/src/api/dto.ts`, derived from the collection schemas. Route contract tests (`apps/admin/lib/api-server/market-contract.int.test.ts`) parse real responses with them. Each contract below names its DTOs.                                                                                                                                                                                     |

## List v2 conventions (M7.2–M7.5)

`GET /api/companies` (M7.2), `/api/jobs` (M7.3), `/api/sources` (M7.4) and `/api/review` (M7.5)
share these parameters (code: `packages/market/src/api/list.ts`). v1 calls keep working.

| Parameter           | Values                                          | Semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sort`              | one whitelisted key per endpoint; `-key` = desc | Each key is index-backed. The order is always tie-broken on `_id` (same direction as the key), so it is total and stable. Missing values sort first ascending and last descending. Unknown keys are 400. Multi-key sorts are not offered: pick the named key.                                                                                                                                                                                                                                                                                                                                                                       |
| `after`             | opaque cursor (`nextCursor` of the last page)   | Keyset pagination: rows strictly after the last row of the previous page in the current sort. Rows inserted while paging never cause duplicates or skip rows that existed when paging started (a row whose sort value changes may move). A cursor is bound to its `sort` (400 otherwise); malformed cursors are 400. Cannot be combined with `offset` (400). A cursor the server issued is always accepted (≤ 2 000 characters): when the last row's sort value is very long (a long name or title) the cursor references that row instead and its sort values are re-read when used (400 only if that row has since been deleted). |
| `offset`            | 0–100 000                                       | v1 offset pagination, kept for compatibility. Prefer `after` for deep pages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `limit`             | 1–200, default 50                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `count`             | `exact` \| `none`                               | `exact` computes `total` for the whole filter (not the page); `none` skips that query and returns `total: null`. Default `exact`, except `none` when a live semi-join filter (`hasActiveJobs`, `hasOpenReviews`) is present; with such a filter, `count=exact` is a 400 when more than 10 000 records qualify (the per-row fallback would look up every row). Use `none` when paging with `after`.                                                                                                                                                                                                                                  |
| `view`              | `full` (default) \| `summary`                   | `summary` returns the endpoint's summary row: scalars plus a `SummaryFact` (value, status, confidence level/score, `basis` = `reasons[0]`, `alternates` = the number of `conflicts[]` entries except the operator-override system reading) per fact, and the summary-row pin `factsHash` (drift detection; see each contract for the full pin and what `rev` means); no evidence. `GET /:id?view=summary` returns the same row for one record.                                                                                                                                                                                      |
| list parameters     | `a,b` or repeated `x=a&x=b`                     | Values of one parameter combine with OR; different parameters combine with AND. Each value is validated (400 on any bad value).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `…After`, `…Before` | `2026-09-29` or ISO-8601 date-time with offset  | Half-open range [after, before).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Response `ListPage<T> = { items, total: number | null, limit, offset, nextCursor: string | null }`
(DTO factory `listPageDto`). `nextCursor` is `null` on the last page (a full page may still be
the last one: the server reads one row ahead). Search parameters are anchored or index-backed;
there is no unanchored substring scan.

**Search (`q`) is breaking vs v1** on every list (v1 ran an unanchored, mostly case-sensitive
regex; the v2 rules are in each contract):

| Endpoint             | v1                                                     | v2                                                                                                                                                             |
| -------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/companies` | substring of the strict name key                       | anchored prefix of the strict name key, an alias key, or (no spaces) the domain                                                                                |
| `GET /api/jobs`      | lower-cased substring of the title (missed mixed case) | every query word is a prefix of a title word (accents, case, punctuation ignored; `c++`, `c#`, `.net` kept), **or** the company matches as above               |
| `GET /api/sources`   | case-insensitive substring of name or key              | every query word is a prefix of a name word, **or** an anchored prefix of the key or of the key after its provider prefix, **or** the company matches as above |

A client that relied on "contains" must switch to prefixes (for jobs: word prefixes, in any order).

**Enum filters match the fact's `value`, whatever its status.** `workModel=remote` returns every
job whose `geography.workModel.value` is `remote`, including values that are `conflicting` or have
low confidence; the same holds for `remoteScope`, `sponsorship`, `relocation`, `employmentType`,
`seniority`, `authorizationRequired`, `salaryStatus`, `currency` and the company `licenceStatus`.
A fact whose status is `unknown` can still carry a value (the sponsorship fact of a silent role is
`{ status: 'unclear', … }` with status `unknown`) and then matches it. For settled values only,
add `hasConflicts=false` and/or `minConfidence=<field>:<level>` (jobs; companies have
`hasConflicts`).

## Fact (every material canonical field)

Schema: `factSchema(T)` in `packages/provenance/src/index.ts`.

```ts
Fact<T> = {
  value: T | null;
  status: 'known' | 'unknown' | 'conflicting';
  confidence: { level: 'high'|'medium'|'low'|'unknown'; score?: number; reasons: string[] };
  evidence: EvidenceReference[];
  conflicts: { value: T | null; evidence: EvidenceReference[]; reason: string }[];
  policyVersion?: string; updatedAt?: Date;
}
EvidenceReference = { sourceId; observationId?; snapshotId?; artifactId?; locator?; quote? (≤300 shown);
                      observedAt; authority?: AuthorityTier; extractor?: { name; version } }
AuthorityTier = 'operator' > 'official_registry' > 'official_ats' > 'official_site' > 'third_party' > 'inferred'
```

Semantics the UI must preserve:

- `status: 'unknown'` means we do not know. Render it as unknown, never as false, 0 or "No". A null
  `value` with status `unknown` is the normal state.
- `conflicting` means sources disagree and the policy could not pick safely. Show the value
  (possibly null) together with `conflicts[]`. A fact can also be `known` and still carry
  `conflicts[]`: the winner was chosen and the losers were kept. Show both.
- Winner selection: field-specific authority first, then confidence, then **source** recency.
  Evidence is never discarded.
- `confidence.reasons[0]` is usually the decision basis (for example `description.explicit`,
  `provider.workplaceType`, `company.sponsorLicence`, `operator override: …`). `score` is present
  only when there is a genuine numeric basis.
- Evidence links: `observationId` → `GET /api/observations/:id`; `artifactId` →
  `GET /api/artifacts/:id` (metadata) and `/api/artifacts/:id/content?preview=<bytes>` (always
  served as `text/plain`, never rendered as HTML); `snapshotId` → `GET /api/snapshots/:id`;
  `sourceId` → `GET /api/sources/:id`.
  - Operator-override evidence on job facts (`authority: 'operator'`, `locator: 'override by
<actorId>'`) cites the **`system:operator` source's id** (M7.1), so it links to
    `GET /api/sources/:id` like any other evidence. Before M7.1 it was the literal `'operator'`;
    a job keeps that value only until its next reconciliation (any re-interpret, refresh or
    review decision). Treat a literal `'operator'` as the operator source.
- For job facts, `locator` is `<observation locator>#<field>[start:end]`, a character span in the
  observation text named by `field` (`description`, `title`, `location`, `provider`). Company-level
  evidence on a job fact (such as a sponsor licence) references the company's licence evidence.

## Employment interpretation enums (job facts)

Source: `packages/market/src/contracts/employment.ts`. These are display-ready enums; the UI owns
the labels.

| Fact (job path)                                   | Value                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geography.workModel`                             | `remote \| hybrid \| onsite \| unclear`. Never a boolean.                                                                                                                                                                                               |
| `geography.remoteScope`                           | `{ type: worldwide\|region\|country\|selected_countries\|timezone\|unclear\|not_applicable, countries[], regions[], excludedCountries[], excludedRegions[], timezone: {minUtcOffset,maxUtcOffset,text}\|null }`                                         |
| `geography.officeAttendance`                      | `{ required: bool\|null, daysPerWeek\|null, officeLocations[] }`                                                                                                                                                                                        |
| `immigration.sponsorship`                         | `{ status: explicit_yes\|explicit_no\|company_capable\|historical_evidence\|unclear, roleStatement: yes\|no\|none, companyCapability: licensed\|previously_licensed\|historical\|none\|unknown, capabilityCountries[] }`                                |
| `immigration.authorization`                       | `{ required: bool\|null, countries[], regions[] (taxonomy codes, e.g. `EU`; M11.1), qualifiers[] (security_clearance, citizenship, permanent_residency) }`. Documents interpreted before M11.1 have no `regions` (treat as `[]`).                       |
| `immigration.relocation`                          | `explicit_yes \| explicit_no \| possible \| unclear`                                                                                                                                                                                                    |
| `compensation`                                    | `{ status: parsed\|unknown\|ambiguous\|malformed, min, max, currency, period, basis, annualized{min,max,assumptions[]}\|null, equityText, bonusText, originalText, warnings[] }`. Missing pay is `unknown`, never 0. `$` outside the US is `ambiguous`. |
| `employment.employmentType`, `identity.seniority` | enums in `employment.ts` (`…                                                                                                                                                                                                                            | unclear`) |

**Sponsorship rules the UI must not blur:**

- `company_capable` means the company holds a relevant licence and the role says nothing. It is
  **not** "this job sponsors". Never label it "Sponsors: yes".
- `roleStatement` and `companyCapability` are independent axes. Show both.
- `historical_evidence` (M11.5) is company **hiring history** for the job's country (US H-1B
  approvals), label "Sponsorship history": weaker than capability, never "this job sponsors",
  never a verdict. Show the fiscal years from `company.employment.sponsorship.history[]` as its
  evidence ("H-1B petitions approved (USCIS): FY… – n").
- **Posting text never yields a sponsorship verdict (DECISION_LOG 012d041, completed by 8d96663
  and narrowed by 3dfe3c5; v0.1 final, policy `employment-policy/2026-09-30.7`).**
  `explicit_yes` / `explicit_no` come **only** from an operator assertion (the review `correct`
  override, below) or a typed provider field (none exists today). From the posting —
  description, title and location — the interpreter derives at most a **statement**:
  - ONE text line `key separator yes|no` whose key names visa, work-permit or immigration
    sponsorship — separator `:`, `–`, `-` or `=`, value `yes` or `no`, at most a trailing period
    and nothing else ("Visa sponsorship: yes", "Visa Sponsorship Available: No", "Work permit
    sponsorship = no", "**Visa sponsorship:** No"; list items and markdown bullets count, text
    before the key on the line does not; text normalised with NFKC, zero-width characters removed
    and straight quotes) — sets flag **`sponsorship_stated`** (info) with `value: "yes" | "no"`
    and `evidence` = the line. Everything else is a **mention**: a key line without a separator
    ("Tier 2 sponsorship available"; "Visa sponsorship available" with "No" on the next line; a
    `<dt>`/`<dd>` or label/value `<div>` pair; a heading followed by "No, …"); another value
    ("Available", "Not available", "Yes (London)"); a footnote marker after the value (`*`, `**`,
    `†`, `‡`, `^`, superscripts, `<sup>`; only paired bold around the whole key or the whole value
    is stripped, and restriction cues such as a leading footnote marker are tested before any
    stripping); and **any line holding text from outside the allowlisted, visible plain-flow
    context** (DECISION_LOG 5a13fed: only `body`, `section`, `article`, `div`, `p`, `li`, `ul`,
    `ol`, `span`, `strong`, `b`, `em`, `i`, `u`, `br`, `h1`–`h6`, none `hidden`, `aria-hidden`,
    with a `role`, any other attribute but `lang`/`dir` (7f01fe5: no CSS is interpreted) — so tables, ARIA
    grids, struck, inserted or highlighted text, links, `details`, `blockquote` and hidden content
    are mentions; markdown `|` rows too; a CSS `display: table` grid of allowlisted `<div>`s is a
    documented residual). Layout is matched by line position, never by text. Statements are
    read from ONE canonical rendering (DECISION_LOG a720377 (1)): the enrichment rendering of the
    copy's `descriptionHtml` whenever it contains markup (5a13fed), else `descriptionText`; evidence into it is
    labelled (`rendering`, locator `#description.html_layout[start:end]`) — show its quote. A
    visa type for another country than the job's (H-1B for a London job; the
    EU Blue Card excludes IE and DK), or unknown job countries, states nothing (a mention);
  - a stated value **does not suppress company-level evidence** (8d96663 (5)): the status follows
    the company axis exactly as for a silent role — `company_capable` for a licence covering the
    job (confidence `low` when any present copy states "no"), `unclear` with
    `sponsor_licence_lapsed`, `sponsor_capability_other_country` or
    `sponsor_capability_job_country_unknown` otherwise — and without company evidence `unclear`,
    confidence `low`, basis `description.stated`;
  - stated values of both polarities — in one copy **or across the job's present copies**
    (8d96663 (2)) — are `sponsorship_conflict` (high, raises an `employment_conflict` review
    citing both lines, `context.stating` = the stating observations and values); each other
    copy's differing value is kept on the fact's `conflicts[]` with its line and the reason
    `lower authority: the copy states visa sponsorship <v>` or `same authority disagreement: …`,
    also behind a sponsorship override (appended after the `overridden by operator` entry);
  - **an operator decision records the decided set** (3dfe3c5 (2)): a `correct` of
    `sponsorship`, a `dismiss` or a `confirm` of the `sponsorship_conflict` item stores
    `job.sponsorshipDecision.stating` (the item's `context.stating`, else the present stating
    copies). While the current stating set is a subset of it, the conflict is the info flag
    `sponsorship_conflict_decided`, no review is raised, and the field is not a listed conflict.
    Any other (observation, value) — a new, changed, merged-in, re-attached or reverted copy —
    raises it again. A job merge keeps the decision (the survivor's, else the merged job's); a
    sponsorship `correct` through a `field_conflict` item records one too; an item closed before
    evidence hashes existed does not suppress (the question is asked once more, a720377 (2)). An
    open `employment_conflict` item whose flag is no longer present is
    dismissed by the system actor `market-employment-conflicts` with the reason recorded (not a
    decision);
  - any other sentence about sponsorship, visas, work permits or the right to work — in the
    description, the **title** or the **location** (e.g. "(No Visa Sponsorship)", "US Citizens
    Only"), in English or common German/French/Dutch/Spanish terms and compounds
    ("Visumsponsoring", "Arbeitsvisa") — is a mention: `sponsorship_mentioned` (info), the span
    kept in `evidence[]`; a mention alone leaves the status to the company axis. A stated value
    together with a mention adds `sponsorship_mixed_statement` (info);
  - `sponsorship_role_overrides_company` (info) marks a stated "no" (of any present copy, when no
    copy states "yes") where the company's licence covers the job's country.
    Show a stated value as "The posting says: …", never as the job's sponsorship status. The gating
    corpus (`fixtures/golden/sponsorship-corpus.json`) fails on any posting-text verdict and on
    any stated value that is not labelled or contradicts the post's statement, whatever the case's
    form; better recall is future work (schema-validated AI proposals gated by the same corpus).
- **M11.1 (policy `employment-policy/2026-09-29.1`; role statements superseded by `.4` above):**
  - A licence when the job's countries are unknown (plain "Remote", no location) is `unclear`.
    `companyCapability` stays `licensed` with `capabilityCountries`, and the fact's confidence is
    `unknown`. Flag `sponsor_capability_job_country_unknown` (info).
  - `companyCapability: previously_licensed` is a licence that is no longer on the register. It is
    past capability, not hiring history, so the status is `unclear`, with flag
    `sponsor_licence_lapsed` (info). Label it "Previously licensed", not "Sponsored before".
  - `historical` / `historical_evidence` are reserved for hiring-history evidence (M11.5). No
    productised source produces them yet.
  - A right-to-work requirement where the licence applies keeps `company_capable`, at low
    confidence, with flag `right_to_work_required_with_sponsor_capability` (info).
- **Operator sponsorship override (B-L2, PR #21 A-M3/B-M1/B-M2, `job-policy/3`):** a `correct`
  of `sponsorship` decides only the role axes, `status` (`explicit_yes | explicit_no | unclear`)
  and `roleStatement`. `companyCapability` and `capabilityCountries` are recomputed from current
  company evidence on every reconciliation. Display recipe:
  - detect the override via `job.overrides.sponsorship` (`{value, reason, actorId, at}`: show
    actor and time);
  - label `status` and `roleStatement` as an **operator decision**;
  - show the company axis as **current**, linking to the company page's licence evidence. The
    fact's `evidence[]` keeps the licence references after the operator span;
  - the recomputed reading is kept in `conflicts[]` with reason `overridden by operator` (like the
    work model), so a later "sponsorship available" in the text stays visible behind an
    `explicit_no` decision. **An `overridden by operator` entry is a "system reading", never a
    conflict**: label it "system reading", do not count it as a disagreement, and do not show it
    in any conflict badge. It never lists the fact in `quality.conflictFields`;
  - `SummaryFact.basis` reads `operator override: <reason>`.
- Jobs interpreted under an older `interpretation.policyVersion` keep their old values until
  re-interpreted (see the reprocessing runbook, "Re-interpret jobs after a logic change").
- M11.2 will add `basisTier` (`role_statement | application_constraint | company_policy |
company_capability | hiring_history | inference | none`) and an evidence ladder (additive).

Interpretation metadata on each job, `interpretation`: `{ logicVersion, policyVersion,
taxonomyVersion, computedAt, basedOnObservationId, flags[{code, message, severity:
info|warning|high}] }`. `high` flags raise `employment_conflict` reviews.

## Observation (raw statement) — `GET /api/observations/:id`

Response: `{ observation: CompanyObservationDoc | JobObservationDoc | null, kind: 'company'|'job',
source: { _id, key, name, authority } | null }`. An unknown id returns **200 `{ observation: null }`**,
not 404. `kind` is derived from the id prefix (`cobs_` = company). Schemas are in
`packages/market/src/observations/schemas.ts`.

Key fields: `payload` (provider-neutral: `companyObservationPayloadSchema` /
`jobObservationPayloadSchema` in `src/contracts/observations.ts`), `resolution { state: pending |
resolved | review | rejected | failed, entityId, method, confidence, reviewItemId }`, `superseded`
(a newer version of the same source record exists; kept as history), `firstObservedAt` and
`lastObservedAt` (**processing** time), `sourceObservedAt` (**source** time; use it for "as of"),
`seenCount`, `parser`, `ai?` (present when AI extracted it; then show "AI-extracted"), `warnings[]`.
Observations are immutable.

## Conflict fields

`quality.conflictFields` (companies and jobs, one definition since PR #21) lists the tracked facts
whose sources genuinely disagree:

- the fact is `status: conflicting` (the policy could not pick a value), or
- a value was picked among **same-authority** sources that disagree (a conflict with reason
  `same authority disagreement…`).

A fact whose value won **by authority** keeps the lower-authority values in `conflicts[]`
(reason `lower authority…`) but is **not** listed: those are "other values kept", not a
disagreement. The value an operator override replaced (reason `overridden by operator`) is never
a disagreement. `hasConflicts` filters on this list. Tracked fields: jobs `identity.title`,
`geography.workModel`, `geography.remoteScope`, `compensation`, `immigration.sponsorship`;
companies `identity.domain`, `identity.displayName`, `firmographics.employeeEstimate`,
`geography.headquarters`. Label each entry by the fact's own `status`. A job's `field_conflict`
review covers compensation, remote scope and sponsorship when any of them disagrees **or** kept
alternates. Its subject says "sources disagree" only for a genuine disagreement and "other values
kept" otherwise (`context.kinds` gives `conflicting | same_authority | alternates` per field).

## Changelog

- **v1.2 (PR #21):** M11.1 employment enums and rules (above); operator sponsorship override display
  recipe; region codes shown as given, never expanded to countries; `quality.conflictFields`
  definition (see "Conflict fields"). **Behaviour change:** job `conflictFields` used to list
  facts that only kept lower-authority alternates; they are no longer listed (so
  `hasConflicts=true` matches fewer jobs), matching companies. The job `field_conflict` review
  still covers alternates, with the subject "other values kept".
  **Behaviour change:** `SummaryFact.alternates` no longer counts the operator-override system
  reading (the value an override replaced, reason `overridden by operator`): a fact decided by an
  operator with no other values reports `alternates: 0`. **Behaviour change (DECISION_LOG 012d041, policy
  `employment-policy/2026-09-29.4`, v0.1 final):** posting text never yields `explicit_yes` /
  `explicit_no`; those come only from an operator assertion (or a typed provider field, none
  today). A structured sponsorship line is a statement: flag `sponsorship_stated` with `value`
  and `evidence` (new optional fields on interpretation flags), status `unclear`. Title and
  location are scanned for mentions. `sponsorship_conflict` (high) marks contradictory stated
  values. `sponsorship_conditional` is no longer produced. Re-interpret jobs to apply it (reprocessing runbook).
  **Behaviour change (DECISION_LOG 8d96663, policy `employment-policy/2026-09-30.7`):** a stated
  value needs key, separator and value on one line (a colon-less key line is a mention); a stated
  value no longer suppresses company-level evidence (status and flags follow the company axis);
  stated values are compared across all present copies (other copies' values kept as
  `conflicts[]` alternates); a newer operator sponsorship override turns the conflict into
  `sponsorship_conflict_decided` (info); open `employment_conflict` items whose flag is gone are
  dismissed by the system; flag `value` is narrowed to `yes | no`. Stored jobs are re-interpreted
  by `market.jobs.reinterpret_outdated` (reprocessing runbook).
  **Behaviour change (DECISION_LOG 3dfe3c5, policy `employment-policy/2026-09-30.7`):** table
  layouts, values other than `yes`/`no` and footnote markers are mentions (the table-cell
  rendering of 8d96663 is reverted); an operator decision records the decided stating set and
  suppresses the conflict only while the current set is a subset of it (the `firstObservedAt`
  rule is dropped); cross-copy alternates are kept behind an override; a cross-copy stated "no"
  counts for company confidence and `sponsorship_role_overrides_company`; reconciliation does not
  re-raise a decided review whose evidence is unchanged, nor raise any for a `CLOSED` job.
  **Behaviour change (DECISION_LOG a720377):** statements are read from the canonical HTML
  layout rendering whenever HTML exists (connector `descriptionText` only without HTML), stray
  table fragments are layout, sponsorship evidence into that rendering is labelled, legacy
  hashless closures re-ask once, merges and field_conflict corrections keep or record decisions.
  **Behaviour change (DECISION_LOG 5a13fed):** stated values only from allowlisted, visible
  plain-flow text (struck, hidden, ARIA-grid and other text is a mention), layout matched by
  position, tagless `descriptionHtml` read as text; review evidence digests are independent of
  the primary copy and hash the interpretation's own reading, never the fact after an override.
  **Behaviour change (DECISION_LOG 7f01fe5):** no CSS is interpreted — a statement line needs
  every overlapping element to be an allowlisted tag with no attribute but `lang`/`dir`, no
  `<style>`/`<link>`/`<script>` in the description, and both HTML parse trees to agree on it;
  work-model digests are per copy; any earlier matching decision suppresses; digests are
  versioned. Deliberately constructed HTML beyond these rules is a Low residual: a stated value is
  never a verdict and is always shown as an unverified quote.
  **Behaviour change (DECISION_LOG bc013e8):** a closed set of inert editor `style` declarations
  and provider wrapper classes, and attribute-free `hr`, are neutral (everything else still
  restricts); a stated value keeps its key's country scope (`scope` on `sponsorship_stated`) and
  counts against a licence only where the scope overlaps it; review items refresh their shown
  evidence with their digest and accept an If-Match digest; work-model items follow any copy;
  readings are keyed by copy, not observation. **Re-verify #14:** the review claim is a
  compare-and-set on the shown digest; stating entries are keyed by copy + value; polarities
  conflict only where key scopes overlap; the licence test is scope ∩ licence ∩ job countries.
  **Final check:** stating entries also carry the key scope and the stated line; the claim is one
  compare-and-set on the shown digest; a resumed or recovered decision applies only on its own
  stored digest.
- **v1.1 (M7.1):** strict query validation, response DTOs, operator evidence cites the
  `system:operator` source.
