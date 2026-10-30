# Market Ops manual test (MKT-OPS-1)

This guide checks the Market pipeline by hand, from a company file to live jobs on a schedule.
You need only a browser and a terminal. You never need the Mongo shell.

## Start

Run each command from the repository root. Use one terminal per service.

```bash
pnpm install
pnpm infra:up        # Mongo, Redis and a local S3 (docker compose); start Docker first
```

Storage is Cloudflare R2. Your `.env` holds `S3_ENDPOINT`, `S3_BUCKET` and the two R2 keys.
The API refuses to start without an explicit endpoint and both keys (FE-3), so it can never
write to Amazon S3 by accident.

```bash
# API on http://127.0.0.1:4000
set -a; . ./.env; set +a; MONGODB_DB=aptamind_mvp QUEUE_PREFIX=aptamind_mvp pnpm dev:admin

# Worker (runs workflows and schedules), health on http://127.0.0.1:4101
set -a; . ./.env; set +a; MONGODB_DB=aptamind_mvp QUEUE_PREFIX=aptamind_mvp pnpm dev:worker

# Admin on http://127.0.0.1:3000
pnpm dev:admin
```

Check that all three are up:

```bash
curl -s http://127.0.0.1:4000/ready     # {"status":"ready","checks":{"mongo":true,"redis":true,"objectStorage":true}}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4101/ready   # 200
```

Use `127.0.0.1`, not `localhost`. The services listen on IPv4 only, and `localhost` can resolve
to IPv6 on macOS.

`aptamind_mvp` holds real data. The default `aptamind` database holds only demo fixtures.

## URLs

Admin: http://127.0.0.1:3000

| Route                           | What it shows                                                  |
| ------------------------------- | -------------------------------------------------------------- |
| `/imports`                      | Every import, its status and counts                            |
| `/imports/new`                  | Start an import (Companies, Known ATS boards, Source snapshot) |
| `/imports/<id>`                 | One import: progress, counts, report, its workflow run         |
| `/companies`, `/companies/<id>` | Canonical companies, their sources and jobs                    |
| `/sources`, `/sources/<id>`     | Sources with schedule, next run, last run and health           |
| `/jobs`, `/jobs/<id>`           | Canonical jobs, lifecycle state and provenance                 |
| `/runs`, `/runs/<id>`           | Workflow runs and their node runs                              |
| `/review`                       | Open review items (conflicts and ambiguity for a person)       |

## Test 1: company import

Save this as `companies.csv` (UTF-8). Only `name` is required. A `domain` lets careers discovery
run.

```csv
name,domain,country,careersUrl
Monzo,monzo.com,GB,
GitLab,gitlab.com,US,
Ramp,ramp.com,US,
```

1. Open `/imports/new` and choose **Companies**. In step 1, choose the CSV file.
2. Check the preview (header and up to 20 rows). The browser reads the file; nothing is uploaded
   yet.
3. In step 2, match each column to a field. A column set to **Don't import** is removed before
   the upload.
4. In step 3, choose **A new list** and give it a name.
5. In step 4, press **Start import**.
6. On `/imports/<id>`, wait for **Completed**. Read the counts: rows, accepted, created, updated,
   failed and reviews. A company that already exists (for example from the board file) counts as
   updated, not created. Import the same file again: every row counts as unchanged.
7. Open `/companies` and find the three companies. Each one is canonical: it was built from an
   observation through resolution, not written directly.
8. On `/imports/<id>`, open the workflow run. On `/runs/<id>`, check that every node completed.
9. Open `/review`. A row that matched more than one company appears here. Expect none for this
   file.

The import also queues careers discovery for each company with a domain. Discovery reads the
company's careers page and looks for a Greenhouse, Ashby or Lever board on it. On
`/companies/<id>`, the careers status becomes `found` and the board appears as a job source. A
board that already exists is reused, never duplicated. With the sample file, Monzo and GitLab
link to Greenhouse and Ramp links to Ashby.

## Test 2: real ATS

1. Open `/companies` and pick a company with a board (for example one from Test 1, or one from
   the owner's board file).
2. On `/companies/<id>`, find its job source. The provider is Greenhouse, Ashby or Lever, and the
   source names the board token.
3. Open the source. Check its last run and the number of jobs it listed.
4. Open the company's jobs, then one job on `/jobs/<id>`.
5. Check provenance on the job page: the source, the observation (`/observations/<id>`) and the
   raw snapshot (`/snapshots/<id>`). The snapshot is the exact bytes fetched from the provider,
   stored in R2 by content hash.

To add many boards at once, use **Known ATS boards** on `/imports/new`. Map either a board or
job URL, or both a provider and a token. Map at least a company name or a domain. A board that is
live creates its company; a board that is not live creates nothing.

## Test 3: lifecycle

A job's state is derived from its evidence every time. One missed run never closes a job.

| You want to see | What to look for                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New job         | After a board's first refresh, its jobs appear as `VERIFIED_LIVE`. An official ATS is authoritative. Only a job seen first on a third-party source starts as `DISCOVERED`. |
| Changed job     | When the provider edits a job's title, description, location or pay, the next refresh marks it `CHANGED`.                                                                  |
| Missing job     | A job absent from a complete listing becomes `POSSIBLY_STALE`.                                                                                                             |
| Closed job      | `CLOSED` needs repeated absences and a not-found check. A job that comes back is `REOPENED`.                                                                               |
| Next refresh    | `/sources/<id>` shows **Next fire** under the schedule.                                                                                                                    |

To force a refresh now, use **Run now** on `/sources/<id>`. When the provider host is cooling
down after a rate limit, the run ends **deferred** with the reason. Nothing is fetched.

## Test 4: automatic execution

1. Open `/sources` and pick a board source.
2. Check the schedule. Boards refresh every 360 minutes, spread across the interval so they do
   not all fire at once.
3. Check **Next fire**. Before the first fire, health shows **Never run**. When a backoff is active after failures, the next run shows the later
   of the next fire and the end of the backoff.
4. Check the previous run and open it.
5. Check health: last success, consecutive failures and the last error.
6. Idempotency: press **Run now** twice. The second run creates no jobs and changes none. An
   unchanged listing takes the cheap confirm path.

## When something looks wrong

- A board that fails again and again backs off. The wait doubles each time, up to 24 hours.
- Source failures: `docs/runbooks/source-failure.md`.
- Review items: `docs/runbooks/review-queue.md`.
