# How canonical provenance is traced

Every material canonical field is a `Fact`:

```json
{
  "value": { "type": "country", "countries": ["US"], "regions": [] },
  "status": "known",
  "confidence": { "level": "high", "reasons": ["description.explicit"] },
  "evidence": [{
    "sourceId": "src_…", "observationId": "jobs_…", "snapshotId": "snap_…", "artifactId": "art_…",
    "locator": "/jobs/0#description[512:571]",
    "quote": "candidates must be located in the United States",
    "observedAt": "2026-09-27T13:29:54Z", "authority": "official_ats",
    "extractor": { "name": "job-interpreter", "version": "…" }
  }],
  "conflicts": [{ "value": { "type": "worldwide" }, "reason": "lower authority", "evidence": [ … aggregator … ] }],
  "policyVersion": "job-policy/3"
}
```

To trace a value:

1. **Canonical → evidence**: Admin company/job pages render each fact with its evidence and
   conflicts (`GET /api/companies/:id`, `GET /api/jobs/:id`).
2. **Evidence → observation**: `observationId` → `GET /api/observations/:id` shows the exact
   payload the source produced, its parser/AI metadata, and its resolution decision.
3. **Observation → raw bytes**: `snapshotId`/`artifactId` + `locator` →
   `GET /api/artifacts/:id/content` (served as text). `locator` is a JSON pointer, CSV row
   (`row:N`), URL, or `field[start:end]` text span; `quote` is verbatim.
4. **Source authority**: `GET /api/sources/:id` (tier, `authoritativeFor`, governance).
5. **Decision history**: `GET /api/audit?entityKind=company&entityId=…` (merges, overrides,
   review decisions), job `lifecycle.history`, and `market_job_verifications`.
6. **Logic versions**: jobs record `interpretation.{logicVersion,policyVersion,taxonomyVersion}`;
   companies record `reconciliation.{logicVersion,policyVersion}`; workflow runs record the
   exact workflow version and `capabilityVersions`.
