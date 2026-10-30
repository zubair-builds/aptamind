# How to add a connector / provider adapter

Job boards: implement `JobBoardAdapter` (`packages/market/src/connectors/types.ts`).

1. Create `connectors/<provider>.ts`:
   - `apiBases` (`{ default, …regional }`: every public API host of the provider; e.g. Greenhouse
     `eu`) and `listingUrl(token, apiBase?)`, `jobUrl(token, externalId, apiBase?)` (verification
     endpoint) built with `onBase(apiBase, path)`. The board token must be one path segment
     directly after the base, so `apiBaseOfListingUrl` can recover the base from a source's
     endpoint (verification uses exactly the host the listing is fetched from),
   - `parseListing(raw, { boardToken })` → `{ jobs: [{ payload, locator }], skipped, complete, warnings }`,
   - `parseJobCheck(status, raw, ctx)` → `live | not_found | unknown`.
2. Map **only** to `JobObservationPayload` (`contracts/observations.ts`). Provider shapes must not
   leak: keep raw payloads in the snapshot and point at them with `locator` (JSON pointer).
3. Skip malformed items with `skipMalformed(listing, entry, locator, reason)`: it records the
   entry in `skipped[]` (with its external id, via `entryExternalId`) and adds a warning. Record
   entries the provider hides but that are still open (e.g. Ashby `isListed: false`) as
   `skipped` with `kind: 'unlisted'` and no warning. A skipped entry is still on the board: its id
   counts as seen and is never marked absent. Throw only when the top-level shape is wrong (the
   caller records a source failure and raises `parser_failure` — never "zero jobs").
4. Set `complete: true` only when the listing is a full snapshot of open jobs (absence is then
   meaningful); otherwise absence handling is skipped. Always `return finishListing(listing)`: it
   clears `complete` when a malformed entry has no usable id or more than 10 % of the listed +
   malformed entries are malformed (unlisted entries are not counted). Parser warnings raise a
   low-severity `parser_failure` review (counts and a sample), keyed by `adapterVersion` and the
   set of malformed entries: bump `adapterVersion` when a fix changes what the adapter maps.
5. Add the provider to `ATS_PROVIDERS` (contract change → review impact on consumers) and to `ADAPTERS`.
6. Commit realistic fixtures under `packages/market/fixtures/ats/<provider>/` (listing,
   single job, not-found) and unit tests asserting payload validity.
7. Detection: teach `discovery/ats-detect.ts` the provider's board/embed URL patterns, including
   regional hosts: a detection carries the `apiBase` of the board's region, and registration
   (`boardSourceIdentity`) accepts only the adapter's known bases.

Company-universe datasets: add a provider module under `sources/providers/` that maps rows to
`CompanyObservationPayload` (see `uk-sponsor-register.ts`), a row-processing capability, and a
workflow template (download → parse → map → filter → `core.for_each` → finalize with anomaly guard).

Source governance: register the source with `governance` metadata (access method, terms,
redistribution/retention notes, crawl policy, rate limit). Never target private or
authenticated third-party systems.
