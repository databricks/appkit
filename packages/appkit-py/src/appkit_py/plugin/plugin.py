"""Abstract Plugin base class.

Mirrors packages/appkit/src/plugin/plugin.ts
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any

from appkit_py.context.execution_context import run_in_user_context
from appkit_py.context.user_context import UserContext
from appkit_py.stream.stream_manager import StreamManager


# Methods excluded from the as_user proxy
_EXCLUDED_FROM_PROXY = frozenset({
    "setup", "shutdown", "inject_routes", "get_endpoints",
    "as_user", "exports", "client_config", "name",
})


class Plugin:
    """Abstract base class for all AppKit plugins."""

    name: str = "plugin"
    phase: str = "normal"  # "core", "normal", or "deferred"

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config = config or {}
        self.stream_manager = StreamManager()
        self._registered_endpoints: dict[str, str] = {}

    async def setup(self) -> None:
        """Async setup hook called after construction."""
        pass

    def inject_routes(self, router: Any) -> None:
        """Register HTTP routes on the given router."""
        pass

    def get_endpoints(self) -> dict[str, str]:
        return dict(self._registered_endpoints)

    def exports(self) -> dict[str, Any]:
        return {}

    def client_config(self) -> dict[str, Any]:
        return {}

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
    """Proxy that wraps all method calls in a user context.

    Python equivalent of the JS Proxy used by asUser() in TypeScript.
    """

    def __init__(self, plugin: Plugin, user_context: UserContext) -> None:
        # Don't call super().__init__ — we delegate everything
        object.__setattr__(self, "_plugin", plugin)
        object.__setattr__(self, "_user_context", user_context)

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._plugin, name)
        if name in _EXCLUDED_FROM_PROXY or not callable(attr):
            return attr

        # Only wrap coroutine functions as async; leave sync methods alone
        if asyncio.iscoroutinefunction(attr):
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                return await run_in_user_context(
                    self._user_context,
                    lambda: attr(*args, **kwargs),
                )
            return async_wrapper

        # Sync callable — return as-is (context won't propagate, but won't break)
        return attr
