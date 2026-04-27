#!/usr/bin/env tsx
/**
 * Companion server for sse-timeout-probe.
 *
 * Serves a single SSE endpoint `/sse-probe` that keeps the connection open for a
 * configurable duration, optionally sending a heartbeat comment. Intended to run
 * inside a Databricks App so a client in the browser (or CLI) can stream against
 * it and measure when the effective idle timeout kicks in.
 *
 * Deploy this as the app's entrypoint, or mount it alongside a larger app.
 */

import { createServer } from "node:http";

const port = Number.parseInt(
  process.env.PORT ?? process.env.DATABRICKS_APP_PORT ?? "8000",
  10,
);

// Server-side ladder bounds: hold up to an hour, heartbeat at most every 60s.
// Anything outside these bounds is almost certainly a malformed URL, not a
// legitimate probe — clamp instead of trusting the caller, and never let
// `setTimeout(..., NaN)` collapse to a 1ms tight loop.
const MAX_HOLD_MS = 60 * 60 * 1000;
const MAX_HEARTBEAT_MS = 60 * 1000;

export function parseDurationParam(
  raw: string | null,
  defaultMs: number,
  maxMs: number,
): number {
  if (raw === null || raw === "") return defaultMs;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return defaultMs;
  return Math.min(n, maxMs);
}

export function createProbeServer() {
  return createServer((req, res) => {
    if (!req.url?.startsWith("/sse-probe")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found — try /sse-probe\n");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const holdMs = parseDurationParam(
      url.searchParams.get("hold-ms"),
      120_000,
      MAX_HOLD_MS,
    );
    const heartbeatMs = parseDurationParam(
      url.searchParams.get("heartbeat-ms"),
      0,
      MAX_HEARTBEAT_MS,
    );

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });

    // Initial event so the client can measure time-to-first-byte.
    res.write(
      `event: probe-start\ndata: ${JSON.stringify({ holdMs, heartbeatMs })}\n\n`,
    );

    let heartbeat: NodeJS.Timeout | undefined;
    const stopHeartbeat = (): void => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };
    if (heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      }, heartbeatMs);
    }

    const stop = setTimeout(() => {
      stopHeartbeat();
      res.write(
        `event: probe-end\ndata: ${JSON.stringify({ reason: "hold-elapsed" })}\n\n`,
      );
      res.end();
    }, holdMs);

    const cleanup = (): void => {
      stopHeartbeat();
      clearTimeout(stop);
    };
    req.on("close", cleanup);
    // Async write failures (proxy half-closes between heartbeats, etc.) land
    // here as 'error' events on the response. Without a listener, Node's
    // default behaviour would crash the server.
    res.on("error", cleanup);
  });
}

const invokedDirectly =
  typeof require !== "undefined"
    ? require.main === module
    : import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const server = createProbeServer();
  server.listen(port, () => {
    process.stdout.write(`sse-timeout-probe server listening on :${port}\n`);
  });
}
