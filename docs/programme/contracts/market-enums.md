# Contract: Market enums with labels (`GET /api/meta/enums`)

Owner: Market (the `market.*` catalog). The endpoint and the `core.*` catalog of Foundation enums
are shared composition (`apps/admin/lib/api-server/routes/meta.ts`); another domain registers its catalog
there. Consumer: Admin UX (filters, badges, editors). Status: **v1.2 (M11.5: H-1B values, "Sponsorship history" labels)** = v1 (M7.7, Admin ask API-10) + the register adapter values (v1.1, M8.4) + M11.5.
Conventions: [market-provenance](market-provenance.md). Code: `packages/market/src/api/enums.ts`
(`MARKET_ENUMS`), `apps/admin/lib/api-server/routes/meta.ts` (`CORE_ENUMS`, `ENUM_CATALOGS`,
`enumsQuerySchema`, DTO `enumsResponseDto`).

## GET /api/meta/enums

| Query    | Values                                                | Notes                                                         |
| -------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| `domain` | a registered catalog: `core`, `market` (default: all) | Derived from the registered catalogs; anything else is a 400. |

Response 200 (`Cache-Control: private, max-age=300`: browser cache only, the surface is
internal; static per deploy):

```ts
{
  enums: Record<
    `${catalog}.${name}`,
    {
      appliesTo: string[]; // response paths and list filters that use these values (free text)
      values: { value: string; label: string; description?: string }[]; // in the owner's order
    }
  >;
}
```

- **`core.*`** (Foundation constants): `core.factStatus` (`@aptamind/provenance` `FACT_STATUSES`),
  `core.confidenceLevel` (`CONFIDENCE_LEVELS`), `core.authorityTier` (`AUTHORITY_TIERS`),
  `core.runState` (`@aptamind/workflows` `RUN_STATES`).
- **`market.*`**: `jobState`, `workModel`, `remoteScope`, `sponsorship`,
  `sponsorshipRoleStatement`, `sponsorshipCompanyCapability`, `relocation`, `employmentType`,
  `seniority`, `salaryStatus`, `payPeriod`, `compensationBasis`, `verificationOutcome`,
  `careersDiscoveryStatus`, `licenceStatus`, `sourceCategory`, `sourceHealth`, `sourceFreshness`,
  `reviewType`, `reviewSeverity`, `reviewAction`, `reviewQueueState`; M8.4: `sponsorRegister`
  (register ids, label = register title, description = publisher, tier and the one country it is
  evidence for), `registerRoute` (the canonical route labels of registers with a route taxonomy, as
  stored in `licences[].route`; UK routes are the register's own labels and are not listed),
  `registerRouteMeaning` (`labour | history | ignored`), `registerEvidenceTier`
  (`capability | history`), `identityNamespace` (`uk_sponsor_register`, `nl_kvk`, `us_h1b_employer`,
  M11.5; `ats`, OPS-1b: a live ATS board, its board key `<provider>:<lowercased token>` or `<provider>:<region>:<lowercased token>`); M11.5 adds register `us_uscis_h1b_employer_data_hub` and route `H-1B` (meaning `history`). These are built
  from the register adapters (`REGISTER_ADAPTERS`), so a new register adds its values here.

Semantics:

- The values are the owners' constants, the ones the API validates filters with and returns: a
  value listed here is accepted by the filters in `appliesTo`, anything else is a 400. New values
  appear here in the release that can return them.
- **Labels (ruling):** the owning domain supplies the default `label` and, where a value is easy
  to blur, a must-not-blur `description`. The UI may shorten a label or restyle it, but must never
  change its meaning, and should show `description` as help text. Examples: `unclear`/`unknown`
  are not "no"; `market.sponsorship.company_capable` is company capability, **not** "this job
  sponsors"; `explicit_yes` / `explicit_no` are operator assertions only — posting text never
  yields them (flag `sponsorship_stated`, PR #21; their served `description` says so without a
  qualifier since M6.2: "posting text never yields it"); `market.sponsorshipCompanyCapability.historical`
  is hiring history, label **"Sponsorship history"** (as `market.sponsorship.historical_evidence`;
  never "Sponsored before", "sponsors" or "licensed"), distinct from the lapsed-licence values
  `market.sponsorshipCompanyCapability.previously_licensed` and `market.licenceStatus.previously_licensed`
  ("Previously licensed"); `inconclusive`
  verification is never closure; an `unknown` salary is never 0.
- Enum filters match a fact's `value` whatever its status (provenance contract): render
  `core.factStatus` / `core.confidenceLevel` next to the value.
- Deferred: a structured `appliesTo` (typed path / parameter pairs) — free text in v1.

Errors: 400 `validation_failed` for an unknown `domain` or parameter.
