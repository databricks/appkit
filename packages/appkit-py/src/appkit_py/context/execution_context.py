"""Execution context using Python contextvars.

This is the Python equivalent of the TypeScript AsyncLocalStorage-based
context from packages/appkit/src/context/execution-context.ts.
"""

from __future__ import annotations

import contextvars
from typing import Any, Awaitable, Callable, TypeVar

from .user_context import UserContext

T = TypeVar("T")

_user_context_var: contextvars.ContextVar[UserContext | None] = contextvars.ContextVar(
    "user_context", default=None
)


async def run_in_user_context(user_context: UserContext, fn: Callable[[], Awaitable[T]]) -> T:
    """Run an async function in a user context."""
    token = _user_context_var.set(user_context)
    try:
        return await fn()
    finally:
        _user_context_var.reset(token)


def get_user_context() -> UserContext | None:
    """Get the current user context, or None if not in a user context."""
    return _user_context_var.get()


def get_execution_context() -> UserContext | None:
    """Get the current execution context (user or None for service principal)."""
    return _user_context_var.get()


def get_current_user_id() -> str:
    """Get the current user ID, or 'service-principal' if not in user context."""
    ctx = _user_context_var.get()
    if ctx is not None:
        return ctx.user_id
    return "service-principal"


def is_in_user_context() -> bool:
    """Check if currently running in a user context."""
    return _user_context_var.get() is not None
