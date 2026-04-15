"""Unit tests for execution context (contextvars-based user context propagation)."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.unit


class TestExecutionContext:
    def test_import(self):
        from appkit_py.context.execution_context import (
            get_execution_context,
            is_in_user_context,
            run_in_user_context,
        )

    async def test_default_is_not_user_context(self):
        from appkit_py.context.execution_context import is_in_user_context

        assert is_in_user_context() is False

    async def test_run_in_user_context(self):
        from appkit_py.context.execution_context import (
            get_current_user_id,
            is_in_user_context,
            run_in_user_context,
        )
        from appkit_py.context.user_context import UserContext

        ctx = UserContext(
            user_id="test-user-123",
            token="fake-token",
        )

        async def inner():
            assert is_in_user_context() is True
            assert get_current_user_id() == "test-user-123"
            return "done"

        result = await run_in_user_context(ctx, inner)
        assert result == "done"

    async def test_context_does_not_leak(self):
        from appkit_py.context.execution_context import (
            is_in_user_context,
            run_in_user_context,
        )
        from appkit_py.context.user_context import UserContext

        ctx = UserContext(user_id="u1", token="t1")

        async def inner():
            assert is_in_user_context() is True

        await run_in_user_context(ctx, inner)
        # After exiting, should no longer be in user context
        assert is_in_user_context() is False

    async def test_nested_user_contexts(self):
        from appkit_py.context.execution_context import (
            get_current_user_id,
            run_in_user_context,
        )
        from appkit_py.context.user_context import UserContext

        ctx_outer = UserContext(user_id="outer", token="t1")
        ctx_inner = UserContext(user_id="inner", token="t2")

        async def inner_fn():
            assert get_current_user_id() == "inner"

        async def outer_fn():
            assert get_current_user_id() == "outer"
            await run_in_user_context(ctx_inner, inner_fn)
            # After inner returns, should restore outer context
            assert get_current_user_id() == "outer"

        await run_in_user_context(ctx_outer, outer_fn)
