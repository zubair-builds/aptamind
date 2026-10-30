# ADR-0006: SSRF-safe acquisition, scoped crawling and politeness

- Status: Accepted
- Date: 2026-09-27

## Context

Crawlers and connectors fetch attacker-influenced URLs.

## Decision

`@aptamind/net` validates protocols and hosts, blocks private/loopback/link-local/metadata addresses at DNS lookup (so redirects and DNS rebinding cannot bypass it), re-validates every redirect hop against the host scope, and enforces timeouts, size limits and per-host concurrency/interval. The headless browser validates every request in an isolated context and blocks out-of-scope navigation. Private networking is only allowed by explicit development/test config and refused in production. Rate limiting is per process (documented limitation).

## Consequences

Safe by default; horizontal scaling multiplies per-host budgets by worker count — acceptable at v0.1 volumes, move to a Redis-backed limiter if needed.
