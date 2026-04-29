"""Companion server for sse-timeout-probe.

Serves /sse-probe with configurable hold and heartbeat — same wire behavior as
server.ts, rewritten in Python stdlib so it runs on the Spaces microVM image
(no npx/tsx available). The probe client is unchanged.
"""

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


# Mirrors server.ts clamps. Anything outside these is almost certainly a
# malformed URL, not a legitimate probe — clamp instead of trusting the caller.
MAX_HOLD_MS = 60 * 60 * 1000
MAX_HEARTBEAT_MS = 60 * 1000


def parse_duration(raw: str | None, default_ms: int, max_ms: int) -> int:
    if raw is None or raw == "":
        return default_ms
    try:
        n = int(raw)
    except ValueError:
        return default_ms
    if n < 0:
        return default_ms
    return min(n, max_ms)


class ProbeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Stderr is captured by /logz; stdout flooding is unhelpful for our
        # measurement of long-lived connections.
        return

    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/sse-probe"):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"not found - try /sse-probe\n")
            return

        params = parse_qs(url.query)
        hold_ms = parse_duration(
            (params.get("hold-ms") or [None])[0], 120_000, MAX_HOLD_MS
        )
        heartbeat_ms = parse_duration(
            (params.get("heartbeat-ms") or [None])[0], 0, MAX_HEARTBEAT_MS
        )

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache, no-transform")
        # X-Accel-Buffering=no asks any nginx in front to flush instead of buffer.
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        try:
            self.wfile.write(
                f"event: probe-start\ndata: {json.dumps({'holdMs': hold_ms, 'heartbeatMs': heartbeat_ms})}\n\n".encode()
            )
            self.wfile.flush()

            start = time.monotonic()
            deadline = start + hold_ms / 1000
            next_beat = start + heartbeat_ms / 1000 if heartbeat_ms > 0 else None

            while True:
                now = time.monotonic()
                if now >= deadline:
                    break
                if next_beat is not None and now >= next_beat:
                    self.wfile.write(f": heartbeat {int(time.time() * 1000)}\n\n".encode())
                    self.wfile.flush()
                    next_beat += heartbeat_ms / 1000
                # Sleep until the next event (heartbeat or deadline).
                next_event = min(deadline, next_beat) if next_beat is not None else deadline
                remaining = next_event - time.monotonic()
                if remaining > 0:
                    time.sleep(min(remaining, 1.0))

            self.wfile.write(
                f"event: probe-end\ndata: {json.dumps({'reason': 'hold-elapsed'})}\n\n".encode()
            )
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # Client/proxy disconnected mid-stream; nothing to clean up.
            pass


def main():
    port = int(os.environ.get("DATABRICKS_APP_PORT") or os.environ.get("PORT") or "8000")
    server = ThreadingHTTPServer(("0.0.0.0", port), ProbeHandler)
    print(f"sse-timeout-probe server listening on :{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
