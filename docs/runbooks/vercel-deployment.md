# Vercel deployment checklist

This deploys `apps/admin` as the Next.js UI and HTTP API. The workflow worker remains a separate
long-running service. Vercel does not replace MongoDB, Redis, object storage, or the worker.

## 1. Provision external services

- [ ] MongoDB Atlas (or another managed MongoDB replica set)
- [ ] Redis with TLS support and BullMQ-compatible connections
- [ ] Cloudflare R2 (or another S3-compatible object store)
- [ ] A worker host such as Railway, Render, Fly.io, or a VM
- [ ] Restrict database and Redis network access to Vercel/worker egress where supported
- [ ] Create separate production database, Redis prefix, and bucket from development

MongoDB must support transactions and use a replica-set connection string. R2 credentials must
be scoped to the production bucket.

## 2. Configure the Vercel project

- [ ] Import the repository into Vercel
- [ ] Framework preset: `Next.js`
- [ ] Root directory: repository root (the workspace packages are required at build time)
- [ ] Install command: `pnpm install --frozen-lockfile`
- [ ] Build command: `pnpm --filter @aptamind/admin build`
- [ ] Output directory: leave the Next.js default
- [ ] Enable production environment variables for Production and Preview as appropriate

## 3. Configure Vercel environment variables

Set these in the Vercel project. Never commit real values.

```env
NODE_ENV=production
NEXT_PUBLIC_APP_URL=https://your-domain.example

MONGODB_URI=mongodb+srv://...
MONGODB_DB=aptamind_production

REDIS_URL=rediss://...
QUEUE_PREFIX=aptamind_production

S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=aptamind-production-artifacts
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=false

AI_PROVIDER=none
WORKER_SCHEDULER_ENABLED=false
NET_ALLOW_PRIVATE_NETWORK=false
```

Do not use localhost values in Vercel:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/...
REDIS_URL=redis://127.0.0.1:6379
S3_ENDPOINT=http://127.0.0.1:9000
```

Only set `AI_PROVIDER=anthropic` after configuring the provider key in the Vercel and worker
environments and confirming the data-processing policy.

## 4. Run database setup

Run migrations once from a trusted environment that has the production variables loaded. Do not
run migrations on every Vercel request or build.

```bash
set -a
. ./.env.production
set +a
pnpm db:migrate
```

Use the same production MongoDB, Redis, and R2 values for the worker. Use a unique
`QUEUE_PREFIX` if multiple environments share Redis.

## 5. Deploy the worker separately

Configure the worker host with:

- [ ] `MONGODB_URI` and `MONGODB_DB`
- [ ] `REDIS_URL` and `QUEUE_PREFIX`
- [ ] R2/S3 variables
- [ ] `WORKER_SCHEDULER_ENABLED=true`
- [ ] `WORKER_METRICS_PORT=0` unless the host provides a private health port
- [ ] `NET_ALLOW_PRIVATE_NETWORK=false`
- [ ] `AI_PROVIDER` and provider credentials, if enabled

Build and start commands:

```bash
pnpm install --frozen-lockfile
pnpm --filter @aptamind/worker build
pnpm --filter @aptamind/worker start
```

Keep the worker running continuously. Vercel functions are not a replacement for the scheduler,
queue consumers, lease recovery sweeper, or browser workloads.

## 6. Security gate before going public

- [ ] Add authentication before exposing the deployment to the public internet
- [ ] Keep Preview deployments protected
- [ ] Verify no production secret is prefixed with `NEXT_PUBLIC_`
- [ ] Restrict CORS and remove development origins
- [ ] Confirm R2 bucket access is private
- [ ] Confirm outbound private-network access remains disabled
- [ ] Set provider data-processing consent and retention policies

The current v0.1 API has no authentication and is intended for private/internal use.

## 7. Validate after deployment

```bash
curl -fsS https://your-domain.example/health
curl -fsS https://your-domain.example/ready
curl -fsS https://your-domain.example/api/meta/enums
```

Then verify:

- [ ] `/ready` reports MongoDB, Redis, and object storage as healthy
- [ ] Admin pages load without an API URL configuration
- [ ] A small workflow run is accepted and completed by the worker
- [ ] An artifact upload and download work through the private bucket
- [ ] Worker logs show queue consumption and scheduler health
- [ ] Preview and production environments use distinct database and queue settings

## Local preflight

Run from the repository root before creating a production deployment:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm check:arch
pnpm --filter @aptamind/admin build
```
