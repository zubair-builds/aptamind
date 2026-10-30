# ADR-0007: Provider-neutral AI gateway; AI output is a proposal

- Status: Accepted
- Date: 2026-09-27

## Context

AI may extract and interpret but must never mutate canonical truth directly (Law H).

## Decision

`@aptamind/ai` exposes `structuredExtract` with a versioned prompt template and Zod schema; providers implement a small JSON-generation contract. The first provider is Anthropic (default model `claude-opus-5`, `output_config.format` JSON schema, server-side refusal fallbacks enabled, SDK retries disabled so the runtime owns retries). Every result records provider, requested and served model, prompt/schema version, input refs/hash, latency, token usage and estimated cost. Without credentials the gateway is `unavailable` and AI steps fail visibly. Market uses AI only as fallback extraction for crawled pages without JSON-LD and as stored, non-canonical requirement proposals; canonical classifications come from deterministic policy.

## Consequences

Deterministic behaviour and golden tests do not depend on a provider. Structured extraction quality from AI is not evaluated in v0.1 (no credentials in this environment).
