# Architecture decision records

| ADR                                              | Decision                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| [0001](0001-modular-monolith-with-workers.md)    | Modular monolith with asynchronous workers                                  |
| [0002](0002-mongodb-state-bullmq-transport.md)   | MongoDB is the source of truth; BullMQ is transport only                    |
| [0003](0003-workflow-runtime-design.md)          | Static DAG runtime with bounded fan-out and no code node                    |
| [0004](0004-official-driver-and-zod.md)          | Official MongoDB driver + Zod; no ODM                                       |
| [0005](0005-observation-first-provenance.md)     | Observation-first ingestion with fact-level provenance                      |
| [0006](0006-safe-acquisition.md)                 | SSRF-safe acquisition, scoped crawling and politeness                       |
| [0007](0007-ai-gateway.md)                       | Provider-neutral AI gateway; AI output is a proposal                        |
| [0008](0008-no-auth-seam.md)                     | No authentication in v0.1, with a request-context seam                      |
| [0009](0009-content-addressed-artifacts.md)      | Content-addressed artifacts and record sets                                 |
| [0010](0010-job-lifecycle-policy.md)             | Conservative job lifecycle and closure policy                               |
| [0011](0011-company-resolution-policy.md)        | Deterministic company resolution with review on ambiguity                   |
| [0012](0012-toolchain.md)                        | Toolchain versions and local infrastructure                                 |
| [0013](0013-runtime-module-structure.md)         | Runtime as an orchestrator over explicit components                         |
| [0014](0014-local-s3-seaweedfs.md)               | SeaweedFS as the local S3-compatible service                                |
| [0015](0015-capability-idempotency-contract.md)  | At-least-once execution with a typed idempotency contract                   |
| [0016](0016-browser-egress-proxy-and-sandbox.md) | Sandboxed Chromium behind a rebinding-safe egress proxy                     |
| [0017](0017-review-claim-model.md)               | Review decisions via a durable, generation-fenced operation                 |
| [0018](0018-server-side-schema-validation.md)    | Server-side validators derived from the Zod schemas                         |
| [0019](0019-source-chronology.md)                | Source chronology is separate from processing chronology                    |
| [0020](0020-professional-domain-package.md)      | Professional domain package, assertion model and confirmed-truth precedence |
