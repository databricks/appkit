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

const port = Number.parseInt(process.env.PORT ?? process.env.DATABRICKS_APP_PORT ?? "8000", 10);

const server = createServer((req, res) => {
  if (!req.url?.startsWith("/sse-probe")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found — try /sse-probe\n");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const holdMs = Math.max(0, Number.parseInt(url.searchParams.get("hold-ms") ?? "120000", 10));
  const heartbeatMs = Math.max(0, Number.parseInt(url.searchParams.get("heartbeat-ms") ?? "0", 10));

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Initial event so the client can measure time-to-first-byte.
  res.write(`event: probe-start\ndata: ${JSON.stringify({ holdMs, heartbeatMs })}\n\n`);

  let heartbeat: NodeJS.Timeout | undefined;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, heartbeatMs);
  }

  const stop = setTimeout(() => {
    if (heartbeat) clearInterval(heartbeat);
    res.write(`event: probe-end\ndata: ${JSON.stringify({ reason: "hold-elapsed" })}\n\n`);
    res.end();
  }, holdMs);

  req.on("close", () => {
    if (heartbeat) clearInterval(heartbeat);
    clearTimeout(stop);
  });
});

server.listen(port, () => {
  process.stdout.write(`sse-timeout-probe server listening on :${port}\n`);
});
