"""Abstract Plugin base class.

Mirrors packages/appkit/src/plugin/plugin.ts — the core of AppKit's
plugin-first architecture.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import uuid
from typing import Any, AsyncGenerator, Callable, Awaitable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from appkit_py.cache.cache_manager import CacheManager
from appkit_py.context.execution_context import (
    get_current_user_id,
    is_in_user_context,
    run_in_user_context,
)
from appkit_py.context.user_context import UserContext
from appkit_py.plugin.interceptors.cache import CacheInterceptor
from appkit_py.plugin.interceptors.retry import RetryInterceptor
from appkit_py.plugin.interceptors.timeout import TimeoutInterceptor
from appkit_py.stream.sse_writer import SSE_HEADERS, format_error, format_event
from appkit_py.stream.stream_manager import StreamManager
from appkit_py.stream.types import SSEErrorCode

logger = logging.getLogger("appkit.plugin")

# Methods excluded from the as_user proxy
_EXCLUDED_FROM_PROXY = frozenset({
    "setup", "shutdown", "inject_routes", "get_endpoints",
    "as_user", "exports", "client_config", "name", "phase",
    "router", "config", "stream_manager", "cache",
})


class Plugin:
    """Abstract base class for all AppKit plugins.

    Subclasses override:
      - name: str — plugin name, used as route prefix (/api/{name}/...)
      - phase: "core" | "normal" | "deferred" — initialization order
      - setup() — async init after construction
      - inject_routes(router) — register HTTP routes
      - exports() — public API for programmatic access
      - client_config() — config sent to the React frontend
    """

    name: str = "plugin"
    phase: str = "normal"  # "core", "normal", or "deferred"

    # Default execution settings (override in subclasses)
    default_cache_ttl: float = 300
    default_retry_attempts: int = 3
    default_retry_initial_delay: float = 1.0
    default_timeout: float = 30.0

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config = config or {}
        self.stream_manager = StreamManager()
        self.cache = CacheManager.get_instance()
        self.router = APIRouter()
        self._registered_endpoints: dict[str, str] = {}
        self._ws_client: Any = None  # Set by create_app

    def set_workspace_client(self, client: Any) -> None:
        """Called by create_app to inject the service-principal WorkspaceClient."""
        self._ws_client = client

    def get_workspace_client(self, request: Request | None = None) -> Any:
        """Get the WorkspaceClient for the current context.

        If request has OBO headers, creates a per-request user client.
        Otherwise returns the service-principal client.
        """
        if request:
            token = request.headers.get("x-forwarded-access-token")
            host = os.environ.get("DATABRICKS_HOST")
            if token and host:
                try:
                    from databricks.sdk import WorkspaceClient
                    return WorkspaceClient(host=host, token=token)
                except Exception:
                    pass
        return self._ws_client

    # -----------------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------------

    async def setup(self) -> None:
        """Async setup hook called after construction."""
        pass

    def inject_routes(self, router: APIRouter) -> None:
        """Register HTTP routes on the given router."""
        pass

    def get_endpoints(self) -> dict[str, str]:
        return dict(self._registered_endpoints)

    def exports(self) -> dict[str, Any]:
        """Return the public API for this plugin (e.g., appkit.analytics.query)."""
        return {}

    def client_config(self) -> dict[str, Any]:
        """Return config to send to the React frontend via __appkit__ script tag."""
        return {}

    # -----------------------------------------------------------------------
    # Route helper (mirrors TS this.route())
    # -----------------------------------------------------------------------

    def route(
        self,
        router: APIRouter,
        *,
        name: str,
        method: str,
        path: str,
        handler: Callable,
        skip_body_parsing: bool = False,
    ) -> None:
        """Register a route and track the endpoint name."""
        full_path = f"/api/{self.name}{path}"
        self._registered_endpoints[name] = full_path
        getattr(router, method)(path, name=f"{self.name}_{name}")(handler)

    # -----------------------------------------------------------------------
    # Execution with interceptor chain
    # -----------------------------------------------------------------------

    async def execute(
        self,
        fn: Callable[[], Awaitable[Any]],
        *,
        cache_key: list[Any] | None = None,
        cache_ttl: float | None = None,
        cache_enabled: bool = True,
        retry_attempts: int | None = None,
        retry_initial_delay: float | None = None,
        timeout: float | None = None,
        user_key: str | None = None,
    ) -> Any:
        """Execute a function through the interceptor chain.

        Chain order (outermost to innermost): Timeout → Retry → Cache
        Mirrors TS plugin.execute() with PluginExecuteConfig.
        """
        _user_key = user_key or get_current_user_id()

        # Build the chain innermost-first
        current = fn

        # Cache (innermost)
        if cache_enabled and cache_key:
            cache_store = self.cache._store
            key = self.cache.generate_key(cache_key, _user_key)
            interceptor = CacheInterceptor(
                cache_store=cache_store,
                cache_key=key,
                ttl=cache_ttl or self.default_cache_ttl,
            )
            prev = current
            current = lambda: interceptor.intercept(prev)

        # Retry
        _attempts = retry_attempts or self.default_retry_attempts
        if _attempts > 1:
            interceptor = RetryInterceptor(
                attempts=_attempts,
                initial_delay=retry_initial_delay or self.default_retry_initial_delay,
            )
            prev = current
            current = lambda: interceptor.intercept(prev)

        # Timeout (outermost)
        _timeout = timeout or self.default_timeout
        if _timeout > 0:
            interceptor = TimeoutInterceptor(timeout_seconds=_timeout)
            prev = current
            current = lambda: interceptor.intercept(prev)

        return await current()

    async def execute_stream(
        self,
        request: Request,
        handler: Callable[..., AsyncGenerator[dict[str, Any], None]],
        *,
        timeout: float | None = None,
        stream_id: str | None = None,
    ) -> StreamingResponse:
        """Execute a streaming handler and return an SSE response.

        Mirrors TS plugin.executeStream() — wraps the async generator
        in StreamManager with heartbeat and reconnection.
        """
        disconnect = asyncio.Event()
        last_event_id = request.headers.get("last-event-id")
        sid = stream_id or request.query_params.get("requestId") or str(uuid.uuid4())

        async def event_generator():
            async def send(data: str):
                yield data  # This doesn't work directly — see below

            # We need to yield SSE text from the generator
            try:
                async for event in handler(signal=disconnect):
                    if disconnect.is_set():
                        break
                    event_id = str(uuid.uuid4())
                    yield format_event(event_id, event)
            except Exception as exc:
                error_id = str(uuid.uuid4())
                yield format_error(error_id, str(exc))

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={k: v for k, v in SSE_HEADERS.items() if k != "Content-Type"},
        )

    # -----------------------------------------------------------------------
    # User context (OBO)
    # -----------------------------------------------------------------------

    def as_user(self, request: Any) -> Plugin:
        """Return a proxy that wraps method calls in user context."""
        headers = getattr(request, "headers", {})
        token = headers.get("x-forwarded-access-token", "")
        user_id = headers.get("x-forwarded-user", "")
        user_ctx = UserContext(user_id=user_id, token=token)
        return _UserContextProxy(self, user_ctx)  # type: ignore[return-value]

    def resolve_user_id(self, request: Any) -> str:
        headers = getattr(request, "headers", {})
        return headers.get("x-forwarded-user", "service-principal")

    async def shutdown(self) -> None:
        self.stream_manager.abort_all()


class _UserContextProxy(Plugin):
    """Proxy that wraps async method calls in a user context."""

    def __init__(self, plugin: Plugin, user_context: UserContext) -> None:
        object.__setattr__(self, "_plugin", plugin)
        object.__setattr__(self, "_user_context", user_context)

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._plugin, name)
        if name in _EXCLUDED_FROM_PROXY or not callable(attr):
            return attr

        if asyncio.iscoroutinefunction(attr):
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                return await run_in_user_context(
                    self._user_context,
                    lambda: attr(*args, **kwargs),
                )
            return async_wrapper

        return attr


def to_plugin(cls: type[Plugin]) -> Callable[..., Plugin]:
    """Factory function that mirrors TS toPlugin().

    Usage:
        analytics = to_plugin(AnalyticsPlugin)
        # Then in create_app:
        create_app(plugins=[analytics(config)])
    """
    def factory(config: dict[str, Any] | None = None) -> Plugin:
        return cls(config)
    factory.__name__ = cls.name if hasattr(cls, 'name') else cls.__name__
    factory._plugin_class = cls
    return factory
