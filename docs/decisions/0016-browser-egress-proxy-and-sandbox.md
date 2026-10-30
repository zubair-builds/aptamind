# ADR-0016: Sandboxed Chromium behind a DNS-rebinding-safe egress proxy

- Status: Accepted
- Date: 2026-09-27 (market foundation hardening, audit finding B-4)

## Context

`core.browser_fetch` and `core.browser_crawl` run untrusted pages in headless Chromium. In
the audited version, requests were checked in a Playwright route handler that validated only
the URL text (scheme, literal IPs, hostname rules), never the addresses a hostname resolves
to. A public name resolving to a private address, DNS rebinding, and WebSockets (which route
handlers do not see) could therefore reach internal services and cloud metadata. Chromium was
also launched with `--no-sandbox`, and the browser tests skipped silently when no browser was
installed.

## Decision

1. **All browser egress goes through `SafeEgressProxy`** (`packages/net`), an in-process HTTP
   and `CONNECT` proxy. It resolves each hostname once, validates every resolved address with
   the same policy as `core.http_request`, and connects to the validated address. Chromium is
   started with `--proxy-server`, `--proxy-bypass-list=<-loopback>`, non-proxied WebRTC UDP
   disabled, and QUIC disabled, so there is no path around the proxy. A blocked main document
   fails the node with `UnsafeUrlError`.
2. **Chromium always runs with its OS sandbox.** The default `--no-sandbox` argument is
   removed and there is no fallback: if Chromium cannot start sandboxed the capability fails
   with `BrowserUnavailableError`. When the worker must run as root (dev containers), a
   wrapper (`scripts/chromium-unprivileged.sh`) drops privileges before executing Chromium.
3. **Browser tests are mandatory.** They fail, not skip, without a browser; CI installs
   Chromium and runs them as their own step.

## Consequences

- Two independent layers: a compromised renderer is still confined by the sandbox, and a
  well-behaved renderer still cannot reach internal addresses.
- Deployments need a Chromium that can sandbox (non-root user, user namespaces allowed).
- The proxy adds one local hop per request, which is negligible next to page loads.
