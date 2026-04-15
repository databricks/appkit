"""Interceptor protocol and context types."""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Protocol, TypeVar

T = TypeVar("T")


class ExecutionInterceptor(Protocol):
    async def intercept(self, fn: Callable[[], Awaitable[Any]]) -> Any: ...
