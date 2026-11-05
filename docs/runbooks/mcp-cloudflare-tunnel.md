# Runbook: expose the worker MCP server through a Cloudflare Tunnel

The MCP server ([ADR-0023](../decisions/0023-mcp-server-worker.md)) listens on `127.0.0.1` only.
A Cloudflare Tunnel on the same machine is the only way remote AI clients reach it.

## 1. Enable MCP in the worker

Generate a token in a terminal (a `.env` file does not expand `$(...)`):

```bash
openssl rand -hex 32
```

Add to the worker's `.env` (never commit it), pasting the 64 hex characters printed above:

```bash
MCP_ENABLED=true
MCP_PORT=4102
MCP_TOKEN=<paste the generated value>
MCP_RUN_WORKFLOW_ALLOWLIST=market.job.propose_requirements
```

Restart the worker and check: `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4102/mcp`
prints `401`. Enable MCP on **one** worker only (rate limits are per process).

## 2. Create the tunnel

```bash
brew install cloudflared            # or the package for your OS
cloudflared tunnel login
cloudflared tunnel create aptamind-mcp
cloudflared tunnel route dns aptamind-mcp mcp.<your-domain>
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: aptamind-mcp
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: mcp.<your-domain>
    service: http://127.0.0.1:4102
  - service: http_status:404
```

Run it: `cloudflared tunnel run aptamind-mcp` (or `cloudflared service install` to keep it running).

## 3. Required: Cloudflare Access

In Zero Trust → Access → Applications, add a self-hosted app for `mcp.<your-domain>` with a
**Service Auth** policy and create a service token. Clients then send
`CF-Access-Client-Id` / `CF-Access-Client-Secret` as well as the bearer. This step is
**required** before the tunnel is used by any remote client. The worker cannot enforce it, so do
not run the tunnel without it. It is the second layer in front of `MCP_TOKEN` (which alone grants
every tool) and stops unauthenticated traffic from reaching the worker or its audit log.

## 4. Connect a client

MCP endpoint: `https://mcp.<your-domain>/mcp` (Streamable HTTP), header
`Authorization: Bearer <MCP_TOKEN>`.

## 5. Verify

- Without the header: `401`. With a wrong token: `401`.
- With the token, `tools/list` returns the tools.
- Each call shows up as an `mcp.*` event in Market audit events.

## Rotate or revoke

Generate a new `MCP_TOKEN`, update the client, restart the worker. To cut access immediately,
stop the tunnel (`cloudflared tunnel` service) or set `MCP_ENABLED=false` and restart.
