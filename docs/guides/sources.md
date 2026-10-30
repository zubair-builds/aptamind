# How to add or reprocess a source

## Add a source

`POST /api/sources` (or Admin → Sources → New). Registration is idempotent on `key`.

```json
{
  "key": "greenhouse:acme",
  "name": "Acme (greenhouse)",
  "category": "job_source",
  "provider": "greenhouse",
  "endpoint": { "boardToken": "acme" },
  "acquisition": { "workflowKey": "market.ats.refresh" },
  "companyId": "cmp_…",
  "schedule": { "intervalMinutes": 360 },
  "freshness": { "policyClass": "source.ats_listing", "maxAgeMinutes": 2160 },
  "authority": {
    "tier": "official_ats",
    "authoritativeFor": ["job existence", "job content"],
    "listingIsComplete": true
  },
  "governance": { "accessMethod": "public_api", "termsNotes": "Greenhouse public job board API" }
}
```

- `acquisition.workflowKey` + `config` define how it is fetched; the run input is
  `{ ...config, sourceId }` and runs are labelled with `sourceId`.
- `schedule` (cron or interval) is mirrored into the runtime scheduler; disabling the source
  disables the schedule.
- `authority.tier` drives reconciliation; `listingIsComplete` allows absence handling.
- `freshness.policyClass` selects the freshness policy (see `freshness/policies.ts`).
- Careers discovery registers ATS sources automatically (`market.register_job_source`).
- **Regional boards (M6.3).** Greenhouse and Lever host EU accounts on separate API hosts
  (`boards-api.eu.greenhouse.io`, `api.eu.lever.co`). An EU board does not exist on the default
  host. Register it with `endpoint.url` set to its EU listing URL (for example
  `https://boards-api.eu.greenhouse.io/v1/boards/acme/jobs?content=true`) and the key
  `greenhouse:eu:acme`. Fetch and verification both use the endpoint's host. Registered or
  patched without `endpoint.url`, an ATS source stores the default-host listing URL, so fetch
  and verification cannot diverge. Discovery registers regional boards automatically from
  `*.eu.greenhouse.io` / `jobs.eu.lever.co` links and embeds.

Built-in workflows: `market.uk_sponsor_register.import`, `market.company_directory.import`
(upload-only company CSV with a column map; see the market-sources contract),
`market.ats.refresh` (Greenhouse, Lever, Ashby, `aggregator` feeds), `market.careers_page.crawl`.

## Run / enable / disable

`POST /api/sources/:id/run`, `/enable`, `/disable`. Health (`never_run`, `healthy`,
`degraded`, `failing`), last attempt/success/failure and errors are on the source.

## Reprocess

See [reprocessing runbook](../runbooks/reprocessing.md): `POST /api/snapshots/:id/reprocess`
or upload a file with `POST /api/sources/:id/snapshots?process=true`.
