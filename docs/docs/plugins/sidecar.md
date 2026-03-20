---
sidebar_position: 8
---

# Sidecar plugin

Run non-Node.js workloads as managed child processes alongside the AppKit server. The sidecar plugin spawns a child process (Python, Go, Ruby, or any executable), manages its lifecycle, and routes requests to it -- enabling polyglot architectures within a single Databricks App.

**Key features:**
- **Two communication modes**: HTTP (child runs its own web server) and stdio (JSON-RPC 2.0 over stdin/stdout)
- **Automatic process lifecycle**: spawn, health monitoring, restart on crash, graceful shutdown
- **Port auto-assignment**: no port conflicts in HTTP mode
- **Auth context forwarding**: Databricks user identity (`x-forwarded-user`, `x-forwarded-access-token`) is passed to the sidecar
- **OpenTelemetry instrumentation**: spans and metrics for every proxied and stdio request
- **Multiple sidecars**: run several child processes from a single plugin instance
- **Security hardening**: command validation, path traversal prevention, header filtering

## Quick start

### HTTP mode (default)

The child process runs its own HTTP server. AppKit proxies all requests under `/api/sidecar/{id}/*` to it.

```ts
import { createApp, sidecar, server } from "@databricks/appkit";

await createApp({
  plugins: [
    server(),
    sidecar([
      {
        id: "python-api",
        command: "python3",
        args: ["-m", "uvicorn", "main:app", "--host", "0.0.0.0"],
        cwd: "./python-api",
        port: 0, // auto-assign
        healthCheck: { path: "/health" },
      },
    ]),
  ],
});
// GET /api/sidecar/python-api/users -> proxied to Python at http://localhost:{auto-port}/users
```

### stdio mode

The child process communicates via stdin/stdout using line-delimited JSON-RPC 2.0. No HTTP server required in the child.

```ts
import { createApp, sidecar, server } from "@databricks/appkit";

await createApp({
  plugins: [
    server(),
    sidecar([
      {
        id: "ml-model",
        mode: "stdio",
        command: "python3",
        args: ["inference.py"],
        cwd: "./ml-model",
        stdio: {
          requestTimeout: 60_000,
          maxConcurrency: 10,
        },
      },
    ]),
  ],
});
// POST /api/sidecar/ml-model/predict -> JSON-RPC over stdin -> Python responds on stdout
```

## Configuration reference

### `ISidecarConfig`

The plugin config accepts either a single `SidecarDefinition` or an array of `SidecarDefinition` entries:

```ts
type ISidecarConfig = SidecarDefinition | SidecarDefinition[];
```

Pass an array for multi-sidecar setups, or a single object for a one-sidecar setup:

```ts
// Single sidecar
sidecar({ id: "api", command: "python3", args: ["main.py"], cwd: "./api" })

// Multiple sidecars
sidecar([
  { id: "api", command: "python3", args: ["main.py"], cwd: "./api" },
  { id: "worker", mode: "stdio", command: "go", args: ["run", "worker.go"], cwd: "./worker" },
])
```

### `SidecarDefinition`

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | `string` | **(required)** | Unique identifier. Used for route namespacing (`/api/{id}/*`). |
| `mode` | `"http" \| "stdio"` | `"http"` | Communication mode. |
| `command` | `string` | **(required)** | Command to execute (e.g., `"python3"`, `"ruby"`, `"go"`). |
| `args` | `string[]` | `[]` | Arguments passed to the command. |
| `cwd` | `string` | `process.cwd()` | Working directory for the child process. |
| `env` | `Record<string, string>` | `{}` | Additional environment variables. Merged with `process.env`. |
| `startupTimeout` | `number` | `30000` | Milliseconds to wait for readiness during `setup()`. |
| `restart` | `RestartConfig` | See below | Process restart configuration. |
| `setupCommands` | `string[]` | `[]` | Commands to run before spawning the process. |
| `setupShell` | `boolean` | `false` | When `true`, setup commands run in a shell (supports pipes, redirects, globbing). When `false`, commands are split on whitespace and executed directly with `execFile` (safer against command injection). |
| `port` | `number` | `0` (auto) | **HTTP mode only.** Port the child listens on. `0` for auto-assign. |
| `healthCheck` | `HealthCheckConfig` | See below | **HTTP mode only.** Health check configuration. |
| `proxy` | `ProxyConfig` | See below | **HTTP mode only.** Proxy behavior configuration. |
| `stdio` | `StdioConfig` | See below | **stdio mode only.** Communication layer configuration. |

### `HealthCheckConfig`

HTTP mode only. Controls readiness polling and periodic health monitoring.

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | `"/health"` | HTTP path for health check requests. |
| `interval` | `number` | `5000` | Milliseconds between periodic health checks. |
| `timeout` | `number` | `3000` | Milliseconds before a single health check request times out. |
| `unhealthyThreshold` | `number` | `3` | Consecutive failures before the process is considered unhealthy and a restart is triggered. |

### `RestartConfig`

Applies to both modes. Controls automatic restart behavior on process crash.

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Whether to automatically restart on crash. |
| `maxRestarts` | `number` | `5` | Maximum restarts within the sliding window before giving up (status becomes `"crashed"`). |
| `restartWindow` | `number` | `60000` | Sliding window in ms. The restart counter resets if this period elapses without a crash. |
| `restartDelay` | `number` | `1000` | Delay in ms before restarting after a crash. |

### `ProxyConfig`

HTTP mode only. Controls how requests are forwarded to the sidecar.

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `forwardHeaders` | `string[] \| "all"` | `"all"` | Which request headers to forward. `"all"` forwards everything except `host` and hop-by-hop headers. A specific list forwards only those headers (plus auth headers, which are always forwarded). |
| `injectHeaders` | `Record<string, string>` | `{}` | Additional headers injected into every proxied request. |
| `timeout` | `number` | `30000` | Milliseconds before a proxied request times out (504 response). |
| `basePath` | `string` | `"/"` | Base path prefix prepended to the request path on the sidecar. |

### `StdioConfig`

stdio mode only. Controls the JSON-RPC communication layer.

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `requestTimeout` | `number` | `30000` | Milliseconds for a single request-response cycle before timing out. |
| `pingInterval` | `number` | `10000` | Milliseconds between ping health checks. |
| `pingFailureThreshold` | `number` | `3` | Consecutive ping failures before the process is considered unhealthy and a restart is triggered. |
| `maxConcurrency` | `number` | `50` | Maximum pending concurrent requests. Excess requests receive a 503 error. |
| `onNotification` | `(method: string, params: unknown) => void` | `undefined` | Callback for custom JSON-RPC notifications from the child. The bridge handles `ready` and `log` internally; all other methods are forwarded here. |

## HTTP mode

### How it works

1. AppKit spawns the child process with `PORT`, `SIDECAR_PORT`, and `DATABRICKS_APP_PORT` environment variables set to the assigned port.
2. The child process starts its own HTTP server on that port.
3. AppKit polls the health check endpoint until it responds with a 2xx status.
4. Once healthy, all requests to `/api/sidecar/{id}/*` are proxied to `http://localhost:{port}/*`.
5. Periodic health checks continue. If the threshold is exceeded, the process is restarted.

### Port assignment

- **Auto-assign (default, `port: 0`):** AppKit binds a temporary `net.Server` on port 0, reads the OS-assigned port, closes the server, then passes the port to the child via `PORT`, `SIDECAR_PORT`, and `DATABRICKS_APP_PORT` environment variables. This avoids port conflicts.
- **Explicit port:** Set `port: 8081` to use a fixed port. The child must listen on that port.

### Health checks

During startup, AppKit polls `GET http://localhost:{port}{healthCheck.path}` at 1-second intervals until a 2xx response or `startupTimeout` is reached. After the process is healthy, periodic checks run at `healthCheck.interval`. After `unhealthyThreshold` consecutive failures, the process is marked unhealthy and restarted.

### Proxy behavior

The proxy uses Node.js built-in `http.request` (no external dependencies). Request and response bodies are **streamed** without buffering, so large payloads and streaming responses work efficiently. Body parsing is automatically skipped for the sidecar route.

**Header forwarding:**
- `forwardHeaders: "all"` (default): All incoming request headers are forwarded, except `host` (rewritten to `localhost:{port}`) and hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, etc.).
- `forwardHeaders: ["content-type", "authorization"]`: Only the listed headers are forwarded, plus `x-forwarded-user` and `x-forwarded-access-token` (always forwarded for auth context).
- `injectHeaders`: Additional headers merged into every proxied request.

**Error responses from the proxy:**

| Status | Condition |
| --- | --- |
| 503 | Sidecar process is not healthy |
| 502 | Connection refused or proxy error |
| 504 | Proxied request timed out |

### Example: Python Flask sidecar

**`python-api/main.py`:**

```python
from flask import Flask, jsonify
import os

app = Flask(__name__)

@app.route("/health")
def health():
    return jsonify(status="ok")

@app.route("/predict", methods=["POST"])
def predict():
    return jsonify(prediction=0.95, model="v2")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
```

**AppKit configuration:**

```ts
sidecar({
  id: "flask-api",
  command: "python3",
  args: ["main.py"],
  cwd: "./python-api",
  port: 0,
  healthCheck: { path: "/health" },
})
```

### Example: Python FastAPI sidecar

**`python-api/main.py`:**

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/predict")
def predict(input: dict):
    return {"prediction": 0.95}
```

**AppKit configuration:**

```ts
sidecar({
  id: "fastapi",
  command: "python3",
  args: ["-m", "uvicorn", "main:app", "--host", "0.0.0.0"],
  cwd: "./python-api",
  port: 0,
  healthCheck: { path: "/health" },
})
```

The `--port` argument is not needed -- uvicorn reads the `PORT` environment variable set by AppKit.

### Example: Go HTTP sidecar

**`go-api/main.go`:**

```go
package main

import (
    "fmt"
    "net/http"
    "os"
)

func main() {
    port := os.Getenv("PORT")
    if port == "" {
        port = "8080"
    }

    http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        fmt.Fprintf(w, `{"status":"ok"}`)
    })

    http.HandleFunc("/compute", func(w http.ResponseWriter, r *http.Request) {
        user := r.Header.Get("X-Forwarded-User")
        w.Header().Set("Content-Type", "application/json")
        fmt.Fprintf(w, `{"result":"done","user":"%s"}`, user)
    })

    http.ListenAndServe(":"+port, nil)
}
```

**AppKit configuration:**

```ts
sidecar({
  id: "go-api",
  command: "go",
  args: ["run", "main.go"],
  cwd: "./go-api",
  port: 0,
  healthCheck: { path: "/health" },
})
```

## stdio mode

### How it works

1. AppKit spawns the child process with `stdin`, `stdout`, and `stderr` all piped.
2. The child signals readiness by sending a `ready` notification on stdout, or by responding to a `ping` request.
3. All requests to `/api/sidecar/{id}/*` are translated into JSON-RPC 2.0 messages written to the child's stdin.
4. The child processes the request and writes a JSON-RPC response to stdout.
5. Periodic ping/pong health checks monitor liveness.

**stdout is reserved for the JSON-RPC protocol.** The child process must write only valid JSON-RPC messages (one per line) to stdout. Use stderr for all logging output. Non-JSON lines on stdout are silently ignored but may indicate a misconfiguration.

### Protocol specification

The stdio bridge uses a subset of [JSON-RPC 2.0](https://www.jsonrpc.org/specification) over newline-delimited JSON. Each message is a single JSON object terminated by `\n`.

#### Ready notification (child -> parent)

The child should send this once it is ready to accept requests:

```json
{"jsonrpc": "2.0", "method": "ready", "params": {}}
```

If the child does not send a `ready` notification, AppKit falls back to ping-based readiness detection. A minimal sidecar only needs to respond to `ping` -- the `ready` notification is optional but recommended for faster startup.

#### Request (parent -> child)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "request",
  "params": {
    "path": "/predict",
    "method": "POST",
    "headers": {
      "x-forwarded-user": "alice@example.com",
      "x-forwarded-access-token": "dapi..."
    },
    "body": {"input": [1, 2, 3]}
  }
}
```

#### Response (child -> parent)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "status": 200,
    "headers": {"content-type": "application/json"},
    "body": {"prediction": 0.95}
  }
}
```

The `result` object maps to `StdioResponsePayload`:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `status` | `number` | `200` | HTTP status code to return to the client. |
| `headers` | `Record<string, string>` | `undefined` | Response headers to set. |
| `body` | `unknown` | `undefined` | Response body (any JSON value). |

#### Error response (child -> parent)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "Database connection failed",
    "data": {"detail": "timeout after 5s"}
  }
}
```

#### Ping / pong (parent -> child)

Used for health checking. The child must respond with any result (conventionally `"pong"`):

```json
{"jsonrpc": "2.0", "id": 42, "method": "ping", "params": {}}
```

Expected response:

```json
{"jsonrpc": "2.0", "id": 42, "result": "pong"}
```

#### Log notification (child -> parent)

Structured logging from the child, forwarded to the AppKit logger:

```json
{"jsonrpc": "2.0", "method": "log", "params": {"level": "info", "message": "Model loaded in 2.3s"}}
```

#### Custom notifications (child -> parent)

Any notification method other than `ready` and `log` is forwarded to the `onNotification` callback:

```json
{"jsonrpc": "2.0", "method": "progress", "params": {"taskId": "abc", "percent": 75}}
```

#### Reserved methods

| Method | Direction | Purpose |
| --- | --- | --- |
| `request` | parent -> child | HTTP request to handle |
| `ping` | parent -> child | Health check (child must respond) |
| `ready` | child -> parent | Readiness signal |
| `log` | child -> parent | Structured log (forwarded to AppKit logger) |

### Example: Python stdio sidecar

**`inference.py`:**

```python
import sys
import json


def handle_request(params):
    path = params.get("path", "")
    method = params.get("method", "POST")
    body = params.get("body", {})
    headers = params.get("headers", {})

    user = headers.get("x-forwarded-user", "anonymous")

    if path == "/predict" and method == "POST":
        return {
            "status": 200,
            "body": {"prediction": 0.95, "user": user},
        }
    elif path == "/health":
        return {"status": 200, "body": {"status": "ok"}}
    else:
        return {"status": 404, "body": {"error": "not found"}}


def main():
    # Signal ready
    sys.stdout.write(
        json.dumps({"jsonrpc": "2.0", "method": "ready", "params": {}}) + "\n"
    )
    sys.stdout.flush()

    # Process requests from stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        msg = json.loads(line)
        msg_id = msg.get("id")
        method = msg.get("method")

        if method == "ping":
            response = {"jsonrpc": "2.0", "id": msg_id, "result": "pong"}
        elif method == "request":
            result = handle_request(msg.get("params", {}))
            response = {"jsonrpc": "2.0", "id": msg_id, "result": result}
        else:
            response = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32601, "message": "Method not found"},
            }

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    # Use stderr for logging -- stdout is reserved for the protocol
    print("Starting inference worker...", file=sys.stderr)
    main()
```

**AppKit configuration:**

```ts
sidecar({
  id: "inference",
  mode: "stdio",
  command: "python3",
  args: ["inference.py"],
  cwd: "./ml-model",
  stdio: {
    requestTimeout: 60_000,  // ML inference can be slow
    maxConcurrency: 10,
  },
  restart: { enabled: true, maxRestarts: 3 },
})
```

### Backpressure and concurrency

The `maxConcurrency` option (default: 50) limits the number of in-flight requests. When the limit is reached, new requests receive a 503 response with `"Sidecar concurrency limit reached"`. This protects both the Node.js process and the child from unbounded memory growth.

If the child process is slow to read from stdin, Node.js buffers writes internally. The bridge logs a debug message when backpressure occurs but does not reject the write -- the message is queued in the Node.js stream buffer.

### Limitations vs HTTP mode

| Concern | HTTP mode | stdio mode |
| --- | --- | --- |
| Streaming responses | Native (chunked HTTP) | Not supported. Response must fit in one JSON message. |
| Binary data | Native (any content-type) | Must be base64-encoded in JSON (~33% overhead). |
| Request body size | Streamed, no buffering | Buffered into JSON, limited by memory. |
| Concurrent requests | Unlimited (TCP) | Bound by `maxConcurrency` (default 50). |
| Child debugging | `curl localhost:{PORT}` | Must send JSON to stdin manually or use a test harness. |
| Framework ecosystem | Any web framework | Must implement the JSON-RPC protocol. |
| stdout usage | Logged by AppKit | **Reserved for protocol only.** Use stderr for logging. |

## Process lifecycle

### Startup sequence

1. **Setup commands**: If `setupCommands` is provided, each command is executed sequentially in the sidecar's `cwd` before spawning. If any command fails, startup is aborted.
2. **Spawn**: The child process is spawned via `child_process.spawn()` with `shell: false`.
3. **Readiness check**:
   - **HTTP mode**: Polls `GET http://localhost:{port}{healthCheck.path}` until a 2xx response.
   - **stdio mode**: Waits for a `ready` notification or a successful `ping` response. Whichever comes first.
4. **Health monitoring begins**: Periodic checks (HTTP polling or ping/pong) start after readiness is confirmed.

If the process does not become ready within `startupTimeout` (default: 30 seconds), the process is killed and a `SidecarError` with code `SIDECAR_ERROR` is thrown. This halts `createApp()`.

### Restart behavior

When the child process exits unexpectedly (and `restart.enabled` is `true`):

1. The restart counter is checked against `maxRestarts` within the sliding `restartWindow`.
2. If under the limit, the process is re-spawned after `restartDelay` milliseconds.
3. If `maxRestarts` is exceeded within the window, the status becomes `"crashed"` and no further restarts are attempted.
4. The restart counter resets if `restartWindow` elapses without a crash.

When a restart is triggered by health check failure (not process exit), the process is first stopped gracefully before re-spawning. In stdio mode, the bridge detaches from the old streams and reattaches to the new process's stdin/stdout.

### Graceful shutdown

On `SIGTERM` / `SIGINT` (or when `abortActiveOperations()` is called during server shutdown):

1. Health checks are stopped.
2. In stdio mode, all pending requests are rejected with a 503 error and the bridge is destroyed.
3. `SIGTERM` is sent to the child process.
4. If the child does not exit within 10 seconds, `SIGKILL` is sent.

This fits within the AppKit server's 15-second shutdown window.

### Status states

| Status | Meaning |
| --- | --- |
| `starting` | Process has been spawned but is not yet ready. |
| `healthy` | Process is running and passing health checks. |
| `unhealthy` | Health checks are failing. A restart may be in progress. |
| `stopped` | Process was intentionally stopped (graceful shutdown). |
| `crashed` | Process exited unexpectedly and max restarts were exceeded. |

## Security

### Command validation

- The `command` string must be non-empty and must not contain shell metacharacters (`;`, `|`, `&`, `$`, `` ` ``, `\n`, `\r`).
- The process is spawned with `shell: false`, so arguments are passed directly to the executable without shell interpretation.
- The `cwd` path is resolved to an absolute path and verified to exist. Null bytes in the path are rejected.

### Proxy path traversal prevention (HTTP mode)

Request paths are normalized with `path.posix.normalize()`. Paths that resolve to `..` (escaping the base path) or contain null bytes are rejected with a 400 response.

### Header filtering (HTTP mode)

- Hop-by-hop headers (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`) are stripped from proxied requests and responses.
- The `host` header is rewritten to `localhost:{port}`.

### Auth context (both modes)

The sidecar receives the requesting user's Databricks identity:
- **HTTP mode**: `x-forwarded-user` and `x-forwarded-access-token` headers are always forwarded, even when `forwardHeaders` is a specific list.
- **stdio mode**: Auth headers are extracted server-side from the incoming request and injected into the JSON-RPC `params.headers` field. They are never taken from the client payload, preventing spoofing.

### stdin injection prevention (stdio mode)

All messages written to stdin use `JSON.stringify()`, which escapes newline characters within strings. This prevents a malicious request body from injecting extra JSON-RPC lines.

## Telemetry

### OpenTelemetry spans

#### HTTP mode

| Span name | Kind | When | Key attributes |
| --- | --- | --- | --- |
| `sidecar.proxy.request` | `CLIENT` | Each proxied HTTP request | `path`, `method`, `target_port`, `duration_ms`, `response_status` |

Span events include `sidecar.proxy.request_forwarded` (when the upstream response arrives) and error details on failure.

#### stdio mode

| Span name | Kind | When | Key attributes |
| --- | --- | --- | --- |
| `sidecar.stdio.request` | `CLIENT` | Each `sendRequest()` call | `request_id`, `path`, `method`, `pending_count`, `duration_ms`, `response_status` |
| `sidecar.stdio.startup` | `INTERNAL` | `waitForReady()` during setup | `timeout`, `ready_signal` (`"notification"`, `"ping"`, or `"timeout"`) |

Span events include `sidecar.stdio.message_sent` (when a message is written to stdin) and error details on failure.

### Metrics

#### HTTP mode

| Metric | Type | Description |
| --- | --- | --- |
| `sidecar.proxy.request.count` | Counter | Total proxied requests, labeled by `path`, `method`, `status`. |
| `sidecar.proxy.request.duration` | Histogram | Round-trip latency in ms, labeled by `path`, `method`. |
| `sidecar.proxy.error.count` | Counter | Errors, labeled by `path`, `error_type`. |
| `sidecar.proxy.pending` | UpDownCounter | Currently in-flight proxied request count. |

#### stdio mode

| Metric | Type | Description |
| --- | --- | --- |
| `sidecar.stdio.request.count` | Counter | Total requests, labeled by `path`, `method`, `status`. |
| `sidecar.stdio.request.duration` | Histogram | Round-trip latency in ms, labeled by `path`, `method`. |
| `sidecar.stdio.error.count` | Counter | Errors, labeled by `path`, `error_type`. |
| `sidecar.stdio.pending` | UpDownCounter | Currently in-flight request count. |
| `sidecar.stdio.healthcheck.count` | Counter | Ping attempts, labeled by `healthy`. |

All telemetry is no-op safe. If `OTEL_EXPORTER_OTLP_ENDPOINT` is not configured, all span and metric calls are no-ops with zero performance impact.

### Viewing traces

Set the `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable to your OpenTelemetry collector endpoint:

```env
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Traces appear under the `sidecar` scope in your observability backend (Jaeger, Grafana Tempo, Databricks, etc.).

## Error handling

### SidecarError types

| Error | Status code | Retryable | When |
| --- | --- | --- | --- |
| Startup failed | 503 | No | Process did not become ready within `startupTimeout`. |
| Process crashed | 503 | Yes | Child exited unexpectedly. |
| Max restarts exceeded | 503 | No | Restart limit reached within the sliding window. |
| Proxy failed | 502 | Yes | HTTP proxy request failed (HTTP mode). |
| Bridge timeout | 504 | Yes | Child did not respond within `requestTimeout` (stdio mode). |
| Bridge request failed | 502 | Depends | Child returned a JSON-RPC error response (stdio mode). Retryable if error code >= -32000. |
| Concurrency exhausted | 503 | Yes | `maxConcurrency` pending requests reached (stdio mode). |
| stdin write failed | 502 | Yes | Failed to write to child stdin (stdio mode). Child may have crashed. |

### HTTP status codes returned to clients

| Status | Condition |
| --- | --- |
| 200 | Successful proxied response (HTTP) or sidecar response (stdio). |
| 400 | Invalid request path (HTTP) or invalid request payload (stdio). |
| 502 | Sidecar connection refused, proxy error, or JSON-RPC error. |
| 503 | Sidecar process is not ready, or concurrency limit reached. |
| 504 | Proxied request or stdio request timed out. |

## Programmatic API

The `exports()` method returns a `SidecarExport` object, accessible as `appkit.sidecar` after `createApp()`:

```ts
const appkit = await createApp({
  plugins: [
    server(),
    sidecar([
      { id: "api", command: "python3", args: ["main.py"], cwd: "./api" },
      { id: "worker", mode: "stdio", command: "go", args: ["run", "worker.go"], cwd: "./worker" },
    ]),
  ],
});

// Get a specific sidecar's export by id
const api = appkit.sidecar.get("api");
api?.getStatus(); // "healthy" | "starting" | "unhealthy" | "stopped" | "crashed"
api?.getPort();   // assigned port (HTTP mode)

// Shorthand helpers target a sidecar by id
const status = appkit.sidecar.getStatus("api");
const lines = appkit.sidecar.getOutput("worker", 50); // last 50 lines

// Restart / stop a specific sidecar
await appkit.sidecar.restart("api");
await appkit.sidecar.stop("worker");

// Iterate all sidecars
for (const [id, sc] of appkit.sidecar.getAll()) {
  console.log(id, sc.getStatus());
}
```

### `SidecarExport` interface

| Method | Signature | Description |
| --- | --- | --- |
| `get` | `(id: string) => SingleSidecarExport \| undefined` | Get the export API for a specific sidecar by id. |
| `getAll` | `() => Map<string, SingleSidecarExport>` | Get all sidecar exports as a Map keyed by id. |
| `getStatus` | `(id: string) => SidecarStatus` | Current process status for a specific sidecar. |
| `restart` | `(id: string) => Promise<void>` | Stop and re-spawn a specific sidecar. |
| `stop` | `(id: string) => Promise<void>` | Stop a specific sidecar. |
| `getOutput` | `(id: string, lines?: number) => string[]` | Recent stdout/stderr lines from the output ring buffer (up to 1000 lines). |
| `getPort` | `(id: string) => number` | Assigned port (HTTP mode). Returns `0` in stdio mode. |

### `SingleSidecarExport` interface

| Method | Signature | Description |
| --- | --- | --- |
| `getStatus` | `() => SidecarStatus` | Current process status. |
| `restart` | `() => Promise<void>` | Stop and re-spawn the process. |
| `stop` | `() => Promise<void>` | Stop the process. |
| `getOutput` | `(lines?: number) => string[]` | Recent stdout/stderr lines from the output ring buffer (up to 1000 lines). |
| `getPort` | `() => number` | Assigned port (HTTP mode). Returns `0` in stdio mode. |

### Route pattern

All sidecar routes are mounted at `/api/sidecar/{id}/*`. In HTTP mode, the route is registered as `"proxy:{id}"`. In stdio mode, it is registered as `"stdio:{id}"`.

### Request format (stdio mode)

Clients send HTTP requests to `/api/sidecar/{id}/{path}`. The route handler:

1. Validates the request with Zod (`path` must be non-empty, `method` must be a valid HTTP method).
2. Extracts auth headers from the incoming request.
3. Sends a JSON-RPC `request` to the child with `{ path, method, headers, body }`.
4. Returns the child's response as the HTTP response.

The client can send any HTTP method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) and any JSON body. The `path` parameter from the URL is passed through to the child process.

## Recipes

### Running multiple sidecars

Pass an array to run multiple child processes from a single plugin instance:

```ts
await createApp({
  plugins: [
    server(),
    sidecar([
      {
        id: "python-api",
        command: "python3",
        args: ["api.py"],
        cwd: "./python-api",
      },
      {
        id: "go-worker",
        mode: "stdio",
        command: "go",
        args: ["run", "worker.go"],
        cwd: "./go-worker",
      },
    ]),
  ],
});
// /api/sidecar/python-api/* -> Python HTTP sidecar
// /api/sidecar/go-worker/*  -> Go stdio sidecar
```

All sidecars start concurrently during `setup()`. Each has independent health checking and restart logic.

For a single sidecar, you can pass a plain object instead of an array:

```ts
sidecar({ id: "python-api", command: "python3", args: ["api.py"], cwd: "./python-api" })
```

### Passing environment variables

```ts
sidecar({
  id: "python-api",
  command: "python3",
  args: ["main.py"],
  cwd: "./python-api",
  env: {
    MODEL_PATH: "/mnt/models/v2",
    LOG_LEVEL: "debug",
    DATABASE_URL: process.env.DATABASE_URL ?? "",
  },
})
```

In HTTP mode, `PORT`, `SIDECAR_PORT`, and `DATABRICKS_APP_PORT` are automatically set. In stdio mode, no port variables are set.

### Forwarding Databricks auth context

The sidecar always receives the user's Databricks identity. In HTTP mode, this arrives as request headers. In stdio mode, it arrives in `params.headers`:

**Python (HTTP mode -- Flask):**

```python
@app.route("/whoami")
def whoami():
    user = request.headers.get("X-Forwarded-User", "anonymous")
    return jsonify(user=user)
```

**Python (stdio mode):**

```python
def handle_request(params):
    user = params.get("headers", {}).get("x-forwarded-user", "anonymous")
    return {"status": 200, "body": {"user": user}}
```

### Custom notifications (stdio mode)

The child process can send custom notifications for progress reporting, metrics, or other events:

**Child process (Python):**

```python
import json, sys

# Send a custom notification
def notify(method, params):
    msg = {"jsonrpc": "2.0", "method": method, "params": params}
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()

# Report progress
notify("progress", {"taskId": "abc", "percent": 50})
```

**AppKit configuration:**

```ts
sidecar({
  id: "worker",
  mode: "stdio",
  command: "python3",
  args: ["worker.py"],
  stdio: {
    onNotification: (method, params) => {
      if (method === "progress") {
        const { taskId, percent } = params as { taskId: string; percent: number };
        console.log(`Task ${taskId}: ${percent}%`);
      }
    },
  },
})
```

## Troubleshooting

### Sidecar fails to start

**Symptom:** `SidecarError: Sidecar process 'python3' failed to become ready within 30000ms`

- Check that the command is installed and available in `PATH`.
- Verify the `cwd` directory exists and contains the expected files.
- In HTTP mode, ensure the child binds to `0.0.0.0` (not `127.0.0.1` or `localhost`) on the port from the `PORT` environment variable.
- In stdio mode, ensure the child writes the `ready` notification to stdout (or responds to `ping`) before the timeout.
- Increase `startupTimeout` for slow-starting processes (e.g., loading ML models).
- Check recent output with `appkit.sidecar.getOutput("your-id")` for error messages from the child.

### stdout pollution breaks stdio mode

**Symptom:** Requests fail or never receive responses.

The stdio protocol requires that **only valid JSON-RPC messages** appear on stdout, one per line. Common causes of stdout pollution:

- Python `print()` statements default to stdout. Use `print(..., file=sys.stderr)` instead.
- Library warnings or progress bars writing to stdout. Redirect them to stderr.
- Python's `-u` flag (unbuffered) may be needed to prevent output buffering: `python3 -u inference.py`.

### Sidecar keeps restarting

**Symptom:** Logs show repeated "Restarting sidecar" messages.

- Check health check configuration. The `path` must return a 2xx status (HTTP mode).
- In stdio mode, ensure the child responds to `ping` requests promptly.
- Increase `healthCheck.unhealthyThreshold` or `stdio.pingFailureThreshold` if the child occasionally takes longer to respond.
- Check if the child process is crashing. Use `appkit.sidecar.getOutput("your-id")` to read stderr logs.

### Port conflicts (HTTP mode)

**Symptom:** `EADDRINUSE` error in sidecar logs.

- Use `port: 0` (the default) for automatic port assignment.
- If using a fixed port, ensure no other process is using it.

### Connection refused (HTTP mode)

**Symptom:** 502 responses with `"Sidecar process is unavailable"`.

- Ensure the child listens on `0.0.0.0`, not just `127.0.0.1`.
- Verify the child reads the `PORT` environment variable.
- Check that the child's HTTP server is fully started before health checks pass.

### Debug logging

Enable verbose sidecar logging by setting the `LOG_LEVEL` environment variable:

```bash
LOG_LEVEL=debug pnpm dev
```

This enables debug-level messages from `sidecar`, `sidecar:process`, `sidecar:proxy`, `sidecar:health`, and `sidecar:stdio-bridge` loggers, showing request/response details, health check results, and stdout parsing.
