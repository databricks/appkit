from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import os


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"status": "ok"})
        elif self.path == "/hello":
            self._respond(200, {"message": "Hello from Python"})
        else:
            self._respond(404, {"error": "not found"})

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())


port = int(os.environ.get("PORT", "8081"))
HTTPServer(("0.0.0.0", port), Handler).serve_forever()
