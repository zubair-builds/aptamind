#!/usr/bin/env bash
# OPTIONAL fallback. The supported local setup is Docker Compose (`pnpm infra:up`); use this
# only where containers cannot run. It starts the same three services from native binaries
# found on PATH (or given via MONGOD_BIN / REDIS_BIN / S3_BIN):
#   - mongod >= 7.0 (single-node replica set rs0)
#   - redis-server >= 7
#   - an S3-compatible server: SeaweedFS `weed` (as in docker-compose.yml) or `minio`
# How the binaries are obtained is up to the machine (package manager, vendor tarball, ...);
# nothing in the repository depends on a particular installer. Data lives in ./.local-infra.
#   bash scripts/local-infra.sh start|stop|status
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.local-infra"
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing binary: $1 (set $2 or use 'pnpm infra:up')" >&2; exit 1; }; }
MONGOD_BIN="${MONGOD_BIN:-$(command -v mongod || true)}"
REDIS_BIN="${REDIS_BIN:-$(command -v redis-server || true)}"
S3_BIN="${S3_BIN:-$(command -v weed || command -v minio || true)}"
mkdir -p "$DATA"/{mongo,redis,s3,logs}

wait_port() { for _ in $(seq 1 60); do (echo >/dev/tcp/127.0.0.1/"$1") >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "port $1 did not open" >&2; return 1; }

start() {
  need "${MONGOD_BIN:-mongod}" MONGOD_BIN
  need "${REDIS_BIN:-redis-server}" REDIS_BIN
  need "${S3_BIN:-weed}" S3_BIN
  if ! (echo >/dev/tcp/127.0.0.1/27017) >/dev/null 2>&1; then
    "$MONGOD_BIN" --dbpath "$DATA/mongo" --port 27017 --bind_ip 127.0.0.1 --replSet rs0 --fork --logpath "$DATA/logs/mongod.log" >/dev/null
    wait_port 27017
    node -e "
      const {MongoClient}=require('$ROOT/node_modules/.pnpm/node_modules/mongodb');
      (async()=>{const c=new MongoClient('mongodb://127.0.0.1:27017/?directConnection=true');await c.connect();
      try{await c.db('admin').command({replSetInitiate:{_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]}})}catch(e){if(!/already initialized/.test(e.message))throw e}
      for(let i=0;i<60;i++){const s=await c.db('admin').command({hello:1});if(s.isWritablePrimary)break;await new Promise(r=>setTimeout(r,500))}
      await c.close()})().catch(e=>{console.error(e);process.exit(1)})"
  fi
  if ! (echo >/dev/tcp/127.0.0.1/6379) >/dev/null 2>&1; then
    "$REDIS_BIN" --port 6379 --bind 127.0.0.1 --dir "$DATA/redis" --appendonly yes --maxmemory-policy noeviction --daemonize yes --logfile "$DATA/logs/redis.log"
    wait_port 6379
  fi
  if ! (echo >/dev/tcp/127.0.0.1/9000) >/dev/null 2>&1; then
    if [[ "$(basename "$S3_BIN")" == weed ]]; then
      nohup "$S3_BIN" server -dir="$DATA/s3" -ip=127.0.0.1 -s3 -s3.port=9000 -s3.config="$ROOT/infra/seaweedfs/s3.json" \
        -master.volumeSizeLimitMB=256 -volume.max=0 >"$DATA/logs/s3.log" 2>&1 &
      echo $! >"$DATA/s3.pid"
    else
      MINIO_ROOT_USER=aptamind MINIO_ROOT_PASSWORD=aptamind-dev-secret nohup "$S3_BIN" server "$DATA/s3" \
        --address 127.0.0.1:9000 --console-address 127.0.0.1:9001 >"$DATA/logs/s3.log" 2>&1 &
      echo $! >"$DATA/s3.pid"
    fi
    wait_port 9000
  fi
  echo "mongo:27017 (rs0) redis:6379 s3:9000 ready"
}

stop() {
  [[ -n "${MONGOD_BIN:-}" ]] && "$MONGOD_BIN" --dbpath "$DATA/mongo" --shutdown >/dev/null 2>&1 || true
  redis-cli -p 6379 shutdown nosave >/dev/null 2>&1 || true
  if [[ -f "$DATA/s3.pid" ]]; then
    local pid; pid="$(cat "$DATA/s3.pid")"
    kill "$pid" 2>/dev/null || true
    # Graceful shutdown can stall; force it after 10 s.
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$DATA/s3.pid"
  fi
}

status() {
  for p in 27017 6379 9000; do (echo >/dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 && echo "$p up" || echo "$p down"; done
}

"${1:-start}"
