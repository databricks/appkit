"""stdio MCP server that forwards to a Databricks-managed MCP endpoint, for an Omnigent session on a Databricks Sandbox.

    python3 -c <this file> <mcp-url>

A Sandbox's Databricks credential is the session owner's own (its default ~/.databrickscfg profile), and Omnigent does
not attach it to HTTP MCP servers. This proxy runs inside the Sandbox, so every tool call reaches the managed MCP
endpoint as the session owner, with their Unity Catalog permissions. Standard library plus the Databricks SDK, which
the Sandbox has.
"""
import json
import sys
import urllib.error
import urllib.request

from databricks.sdk.core import Config

URL = sys.argv[1]
_config = Config()


def forward(message):
    headers = {**_config.authenticate(), "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    request = urllib.request.Request(URL, data=json.dumps(message).encode(), method="POST", headers=headers)
    with urllib.request.urlopen(request, timeout=300) as response:
        raw = response.read().decode()
        if "text/event-stream" in (response.headers.get("content-type") or ""):
            data = [line[5:].strip() for line in raw.splitlines() if line.startswith("data:")]
            return json.loads(data[-1]) if data else None
        return json.loads(raw) if raw.strip() else None


for line in sys.stdin:
    try:
        message = json.loads(line)
    except ValueError:
        continue
    try:
        reply = forward(message)
    except urllib.error.HTTPError as error:
        reply = {"jsonrpc": "2.0", "id": message.get("id"),
                 "error": {"code": -32000, "message": f"{error.code} {error.read().decode()[:300]}"}}
    except Exception as error:  # surfaced to the agent as the tool's error
        reply = {"jsonrpc": "2.0", "id": message.get("id"), "error": {"code": -32000, "message": repr(error)[:300]}}
    if message.get("id") is not None and reply is not None:
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()
