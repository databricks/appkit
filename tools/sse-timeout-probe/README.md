# sse-timeout-probe

Empirical reproducer for the Databricks Apps SSE timeout gap
([ES-1742245](https://databricks.atlassian.net/browse/ES-1742245), UI-01 / UI-02 in
the EMEA Apps "gaps that matter" doc).

## What it does

Opens one SSE connection per duration in a configurable ladder, holds each one
idle (or paced by a server-side heartbeat), and reports how long each connection
actually survived and how it was terminated. Runs against a Databricks App, an
EKS control, or `localhost`. Running it against a known-good origin and the
Databricks-hosted one in sequence gives you the per-layer ceiling without
having to triangulate from noisy LLM traces.

## Why this exists

The source doc (`Apps Gaps That Matter to EMEA Apps`) and ES-1742245 disagree
about what kills SSE connections. The doc says the drop is "distinct from the
120s idle timeout" and blames buffering / HTTP/2 multiplexing. The ticket's own
diagnosis (Naïm Achahboun) says the drop *is* caused by the effective request
timeout — multi-agent LLM calls take varying durations, so some finish under
the ceiling and some don't.

This probe answers the question deterministically: hold an idle SSE for X
seconds, see if it survives, record where the timeout lives. Comparing results
across durations and with/without heartbeat tells you whether the ceiling is
idle-based (heartbeats save it) or absolute (heartbeats don't).

## Usage

```bash
# Inside a workspace: deploy `server.ts` as the app entrypoint.
# Then from a machine with network access to the app URL:
tsx tools/sse-timeout-probe/probe.ts \
  --base-url https://my-app.<workspace>.cloud.databricks.com \
  --header "Cookie=<oauth2-proxy session cookie>" \
  --durations 30000,60000,90000,120000,150000,180000,240000,300000 \
  --json | tee apps-results.jsonl

# Control run against the same codebase on EKS/localhost:
tsx tools/sse-timeout-probe/probe.ts --base-url http://localhost:8000 \
  --json | tee local-results.jsonl

# Compare: if `outcome: server-close` clusters sharply at a duration in the
# Apps run but not locally, that duration is your ceiling.
```

Flags:
- `--base-url <URL>` (required) — base URL of the SSE-serving app.
- `--path <PATH>` — SSE endpoint path. Default: `/sse-probe`.
- `--durations <LIST>` — comma-separated milliseconds, one connection per entry. Default: `30000,60000,90000,120000,150000,180000,240000,300000`.
- `--heartbeat <MS>` — if `>0`, the server emits a keepalive comment every N ms. Distinguishes idle-timeout from absolute request-timeout.
- `--header <K=V>` — extra request header. Repeatable (e.g. for auth cookies).
- `--json` — emit one JSON line per result.

## What to look for

- **Sharp cliff at ~60s, 90s, 120s, or 180s** → that's the effective ceiling. Cross-reference with:
  - `apps/gateway` (`request_timeout=60`, `pool_idle_timeout=90`, `header_read_timeout=30`)
  - `apps/oauth2-proxy` (`DefaultUpstreamTimeout=30`)
  - DP ApiProxy envoy (`idle_timeout=180s` / `1200s`)
- **No cliff, `outcome: completed` throughout** → the drop isn't timeout-driven; follow the buffering / HTTP/2 hypothesis.
- **Cliff moves when `--heartbeat` is added** → idle-timeout. Document the heartbeat pattern as the fix.
- **Cliff is identical with and without heartbeat** → absolute request timeout. Requires per-route override on `apps/gateway`.

## Follow-ups

- Wire the companion server into `apps/dev-playground` so probing is one `pnpm deploy` away.
- Export results to a small notebook template for the comparison visualization.
- Add a WebSocket variant of the probe so UI-02 (ping/pong bypass) can be measured on the same axes.
