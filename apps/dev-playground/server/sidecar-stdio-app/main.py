"""Stdio JSON-RPC 2.0 sidecar for the dev-playground.

Communicates with the AppKit sidecar plugin over stdin/stdout using
line-delimited JSON-RPC 2.0 messages.  All debug output goes to stderr.
"""

import json
import sys


def send(obj: dict) -> None:
    """Write a JSON-RPC message to stdout (one line, flushed)."""
    print(json.dumps(obj), flush=True)


def handle_request(params: dict) -> dict:
    """Route an incoming HTTP-like request and return a stdio response payload."""
    path: str = params.get("path", "")
    method: str = params.get("method", "GET").upper()

    if path == "/hello" and method == "GET":
        return {
            "status": 200,
            "headers": {"content-type": "application/json"},
            "body": {"message": "Hello from Python stdio sidecar!"},
        }

    if path == "/echo" and method == "POST":
        body = params.get("body")
        return {
            "status": 200,
            "headers": {"content-type": "application/json"},
            "body": {"echo": body},
        }

    return {
        "status": 404,
        "headers": {"content-type": "application/json"},
        "body": {"error": "not found"},
    }


def main() -> None:
    # Signal readiness to the parent process.
    send({"jsonrpc": "2.0", "method": "ready"})
    print("[stdio-sidecar] ready", file=sys.stderr, flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            print(f"[stdio-sidecar] invalid JSON: {exc}", file=sys.stderr, flush=True)
            continue

        msg_id = msg.get("id")
        method = msg.get("method")

        if method == "ping":
            send({"jsonrpc": "2.0", "id": msg_id, "result": "pong"})
        elif method == "request":
            params = msg.get("params", {})
            result = handle_request(params)
            send({"jsonrpc": "2.0", "id": msg_id, "result": result})
        else:
            print(
                f"[stdio-sidecar] unknown method: {method}",
                file=sys.stderr,
                flush=True,
            )
            if msg_id is not None:
                send({
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {"code": -32601, "message": f"Method not found: {method}"},
                })


if __name__ == "__main__":
    main()
