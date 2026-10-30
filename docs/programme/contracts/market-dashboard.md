# Contract: Market dashboard, data quality and coverage

Owner: Market (Market sections; the `runs` and `queues` sections are runtime data). Consumer:
Admin UX (home and ops overview). Status: **v1 = `d9799b6`**, plus the planned coverage endpoint
(M6.5). Code: `apps/admin/lib/api-server/routes/ops.ts`, `packages/market/src/queries/dashboard.ts`,
`packages/market/src/freshness/freshness.service.ts`.

## GET /api/dashboard?hours=24 (1–720)

```ts
{
  window: { since: Date, ms: number },
  sources:   { byHealth: Record<'never_run'|'healthy'|'degraded'|'failing', number>,   // excludes system:* sources
               failing: { _id, key, name, health }[] },                                  // degraded + failing, latest failure first
  companies: { total, created, changed },                                                // created/changed within the window
  jobs:      { byState: Record<JobState, number>, created, changed, closed },
  review:    { openByType: Record<ReviewType, number>, open: number, oldestOpenAgeMs: number | null },
  runs:      /* runtime stats: packages/workflows/src/queries.ts#stats */,
  queues:    { queue, …counts }[],                                                       // BullMQ transport counts (may be 0 when Redis is down; state stays in Mongo)
  freshness: { overdueSources: { sourceId, key, name, ageMs: number|null, maxAgeMs, status }[],
               jobsDueForVerification: number }                                          // capped at 1000
}
```

- `ageMs: null` means the source has never succeeded.
- `jobsDueForVerification` saturates at **1000**. Render it as "1000+" when it equals 1000.
- `overdueSources` (M7.4) is an indexed query: enabled, non-system sources whose server-computed
  `freshnessState` is `overdue` or `never_succeeded` (see [market-sources](market-sources.md)),
  oldest success first. The same set is `GET /api/sources?freshness=overdue,never_succeeded&system=false`.

## GET /api/metrics/data-quality?days=7 (1–90)

```ts
{
  window,
  entityQuality: { companyObservationResolution: Record<'pending'|'resolved'|'review'|'rejected'|'failed', n>,
                   unresolvedCompanyRate: number|null, jobObservationResolution: Record<…, n>,
                   duplicateReviews: Record<'company_duplicate'|'job_duplicate', n>,
                   mergedCompanies: n, duplicateCompanyRate: number|null, observationToCanonicalLagMs: number|null },
  jobQuality:    { verifiedLiveRate: number|null, staleRate: number|null,
                   verificationsByOutcome: Record<'live'|'not_found'|'inconclusive', n> },
  intelligence:  { workModel, remoteScope, sponsorship, salaryStatus, workModelConfidence }, // value → count over active jobs
  review:        { decisionsByAction: Record<ReviewAction, n>, correctionRate: number|null }
}
```

Rates are fractions from 0 to 1, or `null` when the denominator is 0. Render null as "—", never
as 0 %. The `intelligence` distributions include `unclear` and `unknown` buckets **on purpose**.
They are quality signals: show them, do not hide them.

## Planned: GET /api/metrics/coverage (M6.5; contract to be finalised in that PR)

The coverage funnel used to prioritise sources (coverage × quality × freshness):

```ts
{
  universe: { companies: n, withDomain: n, bySource: { sourceKey, companies }[] },
  careers:  { byStatus: Record<'not_attempted'|'found'|'not_found'|'failed'|'website_unknown', n>,
              byReason?: Record<string, n> /* M8.5 */ },
  ats:      { detectedByProvider: Record<string, n>, supportedProviders: string[] /* M9.1 adds detect-only families */ },
  jobSources: { byProvider: Record<string, { total, healthy, degraded, failing, never_run }> },
  jobs:     { companiesWithLiveJobs: n, activeJobs: n, byProvider: Record<string, n> },
  acquisition: { parseWarningRateByProvider: Record<string, number|null> /* M6.1 */ }
}
```

Every number comes from the server. The UI never computes funnel ratios from other endpoints.
