# Aptamind worker

Runs workflow nodes and fan-out chunks from the queues, fires schedules and runs the recovery
sweeper (`src/main.ts`).

## Health endpoints

| Server   | Bind                                            | Enabled by                | Paths                           |
| -------- | ----------------------------------------------- | ------------------------- | ------------------------------- |
| Loopback | `127.0.0.1:$WORKER_METRICS_PORT` (default 4101) | `WORKER_METRICS_PORT` > 0 | `/health`, `/ready`, `/metrics` |
| Public   | `0.0.0.0:$PORT`                                 | `PORT` set (by the host)  | `GET`/`HEAD` `/healthz` only    |

The public server is a static liveness check: `200 {"status":"ok"}`, or `503 {"status":"stopping"}`
during shutdown. It touches no dependency and returns no worker id, checks, metrics or error text;
every other path is `404`. It binds before platform init so a host's port scan passes during
startup; if init fails the process exits. If `PORT` equals `WORKER_METRICS_PORT` the loopback
server is not started (a warning is logged), so `/ready` and `/metrics` are never exposed.

## Render (free web service, dashboard-only)

Service `srv-dbisuk942hec73be0hag` is configured in the Render dashboard; there is no
`render.yaml` in the repo (owner decision 2026-10-31).

- Start command: `pnpm --filter @aptamind/worker start` (runs `node dist/main.js` after build).
- Health check path: `/healthz`. Render sets `PORT`.
- Env (names only): `MONGODB_URI`, `MONGODB_DB`, `REDIS_URL`, `QUEUE_PREFIX`, `S3_*`, `AI_*`,
  `GEMINI_API_KEY`, `WORKER_SCHEDULER_ENABLED`, optionally `WORKER_QUEUES`, and optionally
  `WORKER_METRICS_PORT=0` to switch off the loopback server.
- Keep-awake: the free tier spins down after ~15 min without inbound HTTP (queue work does not
  count). Point an UptimeRobot HTTP(S) monitor at `https://<service>.onrender.com/healthz` every
  5 min. Redeploys and restarts still happen; a node mid-run on a restarting worker fails if it has
  one attempt (see the 2026-10-31 UK run, `AttemptsExhausted … lost leases`).

### Scheduler ownership

The Render worker owns the scheduler: `WORKER_SCHEDULER_ENABLED` on. Zubair's local worker should
stop once Render is live. Two workers with the scheduler on against the same `REDIS_URL` +
`QUEUE_PREFIX` can fire schedules twice.

### Heavy jobs stay local for now (conflict)

The free instance has 512 MB RAM. Heavy jobs (the UK sponsor import, ~143k rows, on the `io`
queue) stay on the local worker for now. **This conflicts with stopping the local worker.**
Until it is resolved, pick one:

- Split by queue with the existing `WORKER_QUEUES` setting (no new env var): Render runs
  `WORKER_QUEUES=default,browser,ai` with `WORKER_SCHEDULER_ENABLED=true`; the local worker runs
  `WORKER_QUEUES=io` with `WORKER_SCHEDULER_ENABLED=false`. The local worker must be running when
  the UK schedule fires (06:15 Europe/London) or the `io` jobs wait in the queue. Not yet verified
  that every UK-import node is on `io` (open follow-up).
- Or move the `io` queue to a paid Render instance (open follow-up).
