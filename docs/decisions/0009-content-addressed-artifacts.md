# ADR-0009: Content-addressed artifacts and record sets

- Status: Accepted
- Date: 2026-09-27

## Context

Raw evidence must be preserved and reprocessable; large payloads must not bloat workflow documents (FR-6).

## Decision

Bytes go to S3 under `artifacts/sha256/..`; Mongo stores one `ArtifactRef` per distinct hash (integrity-checked on read). Large collections flow between nodes as JSONL **record sets**; node outputs > 64 KB are offloaded automatically. Snapshots are content-addressed per source; reprocessing uses `snapshotId` instead of refetching.

## Consequences

Idempotent storage and cheap reprocessing. Deleting artifacts (retention policies) is future work and must respect snapshot references.
