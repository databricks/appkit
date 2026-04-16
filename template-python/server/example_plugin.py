"""Example plugin demonstrating the AppKit Python SDK.

Shows how to subclass Plugin, register routes, use the interceptor
chain (execute), and stream results (execute_stream).
"""

import json

import appkit


class ExamplePlugin(appkit.Plugin):
    """A sample plugin with health-check, greeting, and streaming endpoints."""

    def __init__(self):
        super().__init__(
            "example",
            manifest=appkit.PluginManifest(
                "example",
                display_name="Example Plugin",
                description="Demonstrates setup, routes, execute, and streaming",
            ),
        )

    async def setup(self):
        """Called once during app initialization (after registration)."""
        print(f"[{self.name}] plugin initialized")

    def inject_routes(self, router: appkit.Router):
        """Register HTTP endpoints under /api/example/..."""

        router.get("/health", self._health_handler)
        router.post("/greet", self._greet_handler)
        router.get("/stream", self._stream_handler, stream=True)

    # ------------------------------------------------------------------
    # Route handlers
    # ------------------------------------------------------------------

    async def _health_handler(self, request: appkit.Request) -> str:
        """GET /api/example/health — simple health check."""
        return json.dumps({"status": "ok", "plugin": self.name})

    async def _greet_handler(self, request: appkit.Request) -> str:
        """POST /api/example/greet — runs through the interceptor chain.

        Expects JSON body: {"name": "Alice"}
        Uses execute() for caching, timeout, and retry support.
        """
        body = request.json()
        name = body.get("name", "World")

        async def build_greeting():
            return json.dumps({"message": f"Hello, {name}!"})

        result = await self.execute(
            build_greeting,
            user_key=name,
            cache_key=["greet", name],
            cache_ttl=60,
            timeout_ms=5000,
        )

        if result.ok:
            return result.data
        return json.dumps(
            {"error": result.message},
        )

    async def _stream_handler(self, request: appkit.Request):
        """GET /api/example/stream — demonstrates execute_stream().

        Yields numbered items as SSE events. The framework detects this
        async generator (stream=True route) and bridges each yielded
        string to a Server-Sent Event automatically.
        """

        async def generate_items():
            for i in range(5):
                yield json.dumps({"item": i, "total": 5})

        stream = await self.execute_stream(generate_items, timeout_ms=10000)

        async for chunk in stream:
            yield chunk
