# ADR-0014: SeaweedFS as the local S3-compatible service

- Status: Accepted
- Date: 2026-09-27 (F1 audit)

## Context

`docker-compose.yml` and CI used `minio/minio`. That repository no longer exists on Docker Hub
(the registry API returns 404; MinIO stopped publishing community images), so `pnpm infra:up`
and the CI integration job could not start object storage on a clean machine. The runtime
needs only standard S3 operations (bucket create/head, put/get/head object) with path-style
addressing.

## Decision

Use SeaweedFS (`chrislusf/seaweedfs`, Apache-2.0, pinned to `4.47`) as the S3 service in
Docker Compose and CI, on the same host port (9000) and development credentials
(`infra/seaweedfs/s3.json`), so no application configuration changes. `S3ObjectStorage`
stays provider-neutral: MinIO, AWS S3 or any compatible store work by configuration.

## Consequences

The full integration suite (42 tests) and a built API/worker smoke test (migrate, demo seed,
readiness) pass against the Compose stack (MongoDB 7, Redis 7, SeaweedFS). The pinned image
tag must be bumped deliberately. The native fallback script accepts either `weed` or `minio`.
