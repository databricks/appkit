{{- if .plugins.sidecar -}}
"""
Sample Python sidecar for AppKit.

This Flask app runs as a child process managed by the AppKit sidecar plugin.
AppKit auto-assigns a port via the PORT environment variable and proxies
requests from /api/sidecar/* to this server.

Customize this file or replace it with your own stack (FastAPI, Go, Ruby, etc.).
"""

import os

from flask import Flask, jsonify, request

app = Flask(__name__)


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/hello")
def hello():
    user = request.headers.get("x-forwarded-user", "anonymous")
    return jsonify({"message": "Hello from Python sidecar!", "user": user})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
{{- end}}
