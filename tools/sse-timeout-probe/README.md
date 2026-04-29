# sse-timeout-probe

Empirical probe for SSE / streaming response lifetime through Databricks Apps.
Originally built to characterize the cap reported in [ES-1742245] / UI-01 / UI-02.
Now serves as a reusable diagnostic and a regression test for the platform fix.

[ES-1742245]: https://databricks.atlassian.net/browse/ES-1742245

## What it does

Opens one SSE connection per duration in a configurable ladder, holds each one
idle (or paced by a server-side heartbeat), and reports how long each connection
actually survived and how it was terminated. Runs against a Databricks App, an
EKS / localhost control, or any HTTP origin that speaks the probe's
`/sse-probe` contract.

## What we used it for

The cap was a Container-path issue: SSE streams through `apps/oauth2-proxy`
were terminated at exactly **301.5s ± 18ms**, regardless of heartbeat traffic.
Empirical investigation traced it to `upstream_timeout = "5m"` in
`apps/oauth2-proxy/proxy.cfg`, which oauth2-proxy maps to Go's
`transport.ResponseHeaderTimeout`. Despite the stdlib documenting that timer
as header-receipt-only, on HTTP/1.1 chunked-encoding upstream connections it
also fires mid-body — a known quirk acknowledged in
`apps/runtime/pkg/proxy/local_proxy.go:217-221`.

Spaces apps front oauth2-proxy with TLS (HTTP/2) so the body-affecting variant
of the quirk doesn't trigger; verified clean to 600s.

Universe fix: <https://github.com/databricks-eng/universe/pull/1867246>
(bumps `upstream_timeout` to 30m).

## Server contract

Two equivalent server implementations are provided so the probe can be
deployed against any Databricks App regardless of runtime image:

- `server.ts` — TS / Node, for app images that include `npx` / `tsx`.
- `server.py` — Python stdlib only, for app images that don't (e.g. Spaces).

Both serve `GET /sse-probe?hold-ms=<ms>&heartbeat-ms=<ms>` with these semantics:

- Send response headers immediately, then `event: probe-start`.
- If `heartbeat-ms > 0`, emit `: heartbeat <epoch-ms>\n\n` at that interval.
- Hold the connection for `hold-ms` total wall-clock, then send
  `event: probe-end\ndata: {"reason":"hold-elapsed"}\n\n` and close.

`hold-ms` is clamped to 1h, `heartbeat-ms` to 60s, to prevent malformed URLs
from collapsing into tight loops.

## Usage

```bash
# Inside a workspace: deploy server.ts (Container) or server.py (Spaces) as the
# app entrypoint. Then from a machine with network access to the app URL:
tsx tools/sse-timeout-probe/probe.ts \
  --base-url https://my-app.<workspace>.cloud.databricks.com \
  --header "Authorization=Bearer <PAT or workspace token>" \
  --durations 30000,60000,90000,120000,150000,180000,240000,300000 \
  --json | tee apps-results.jsonl

# Or with a session cookie from a logged-in browser:
... --header "Cookie=<oauth2-proxy session cookie>" ...

# Control run on the same codebase, no proxy in path:
tsx tools/sse-timeout-probe/probe.ts --base-url http://localhost:8000 \
  --json | tee local-results.jsonl
```

### Probe flags

- `--base-url <URL>` (required) — base URL of the SSE-serving app.
- `--path <PATH>` — SSE endpoint path. Default: `/sse-probe`.
- `--durations <LIST>` — comma-separated milliseconds, one connection per
  entry. Default: `30000,60000,90000,120000,150000,180000,240000,300000`.
- `--heartbeat <MS>` — if `>0`, the server emits a keepalive comment every
  N ms. Distinguishes idle-timeout from absolute request-timeout.
- `--header <K=V>` — extra request header. Repeatable.
- `--json` — emit one JSON line per result.

## Interpreting results

| Pattern | Diagnosis |
|---|---|
| All `outcome: completed`, lifetimes match targets | No cap on this path. |
| Sharp cliff at duration X, all probes ≥X cut at ~X with `actualLifetimeMs` variance < 100ms | Absolute request-lifetime timer at X. |
| Cliff at X without heartbeat, no cliff with heartbeat | Idle timeout at X, savable with keepalive. |
| Cliff at X identical with and without heartbeat | Absolute timeout (heartbeats don't save it). Look for HTTP/1.1 ResponseHeaderTimeout-style quirks. |
| `outcome: server-close` with `detail: "Body Timeout Error"` and `actualLifetimeMs` near the target hold | Client-side undici `bodyTimeout` (300s default) — not a real proxy cap; rerun with `--heartbeat` to confirm. |

## Verifying the universe fix

Once <https://github.com/databricks-eng/universe/pull/1867246> is broadly
deployed, re-run against a Container app:

```bash
tsx tools/sse-timeout-probe/probe.ts \
  --base-url https://<your-container-app>.cloud.databricks.com \
  --header "Authorization=Bearer $(databricks auth token | jq -r .access_token)" \
  --durations 1500000 --heartbeat 5000 --json
```

Expected: `outcome: completed`, `actualLifetimeMs ≈ 1500000` (25 minutes).
Regression: `outcome: server-close` with `actualLifetimeMs` near some lower
value indicates a new (or returned) cap somewhere in the path.

## Follow-ups

- **WebSocket variant of the probe + wire both probes into `apps/dev-playground`.**
  UI-02's claim is that WS ping/pong bypasses the timeout differently than SSE;
  a `ws-timeout-probe` companion measures the WS path on the same axes.
  Wiring into `dev-playground` makes both probes one `pnpm deploy` away.
- **Promote AppKit's existing `Last-Event-ID` reconnection pattern as the
  recommended shape for long-running SSE apps.** Defense in depth so apps
  degrade gracefully if any future platform timeout reappears. The pieces
  already exist in `packages/appkit` (`StreamManager`, ring buffer, abort
  signals) — this is a docs / examples change.
- **Higher-N concurrency probe** (N=100, N=500) to actually stress the
  HTTP/2 multiplexing hypothesis in the original UI-02 doc. We tested N=20
  and saw no degradation; the doc's claim was about higher concurrency.
- **CI regression test.** Once the universe fix is broadly deployed, an
  integration test that deploys a short-lived test app and runs a small
  probe ladder catches future regressions before they reach customers.

Out of scope for this repo, tracked elsewhere:

- Architectural fix on the Container path (TLS / HTTP/2 between proxies, so
  the Go ResponseHeaderTimeout body-cut quirk doesn't trigger). Apps platform
  / networking work.
- Durable docs of the diagnosis under `apps/tech-docs/`. Universe doc PR
  after #1867246 lands.
