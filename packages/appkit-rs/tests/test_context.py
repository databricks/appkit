"""Integration tests for contextvars-based execution context."""

import pytest

import appkit


class TestContextVars:
    def test_get_current_user_none_by_default(self):
        user = appkit.get_current_user()
        assert user is None

    def test_is_in_user_context_false_by_default(self):
        assert appkit.is_in_user_context() is False

    def test_run_in_user_context(self, user_context):
        def check():
            user = appkit.get_current_user()
            assert user is not None
            assert user.user_id == "user-42"
            assert user.workspace_id == "ws-123"
            assert appkit.is_in_user_context() is True
            return user.user_id

        result = appkit.run_in_user_context(user_context, check)
        assert result == "user-42"

        # After the call, context should be reset
        assert appkit.get_current_user() is None
        assert appkit.is_in_user_context() is False

    def test_run_in_user_context_exception_resets(self, user_context):
        def raise_error():
            assert appkit.is_in_user_context() is True
            raise ValueError("test error")

        with pytest.raises(ValueError, match="test error"):
            appkit.run_in_user_context(user_context, raise_error)

        # Context should be reset even after error
        assert appkit.get_current_user() is None

    @pytest.mark.asyncio
    async def test_as_user(self, user_context):
        async def async_check():
            user = appkit.get_current_user()
            assert user is not None
            assert user.user_id == "user-42"
            return user.user_id

        result = await appkit.as_user(user_context, async_check)
        assert result == "user-42"

    def test_nested_contexts(self):
        outer = appkit.UserContext("tok-outer", "outer-user", workspace_id="ws-1")
        inner = appkit.UserContext("tok-inner", "inner-user", workspace_id="ws-2")

        def outer_fn():
            assert appkit.get_current_user().user_id == "outer-user"

            def inner_fn():
                assert appkit.get_current_user().user_id == "inner-user"
                return "inner-done"

            result = appkit.run_in_user_context(inner, inner_fn)
            # After inner context completes, we should be back to outer
            # Note: contextvars.ContextVar.reset() restores the previous token,
            # so outer context is restored.
            return result

        result = appkit.run_in_user_context(outer, outer_fn)
        assert result == "inner-done"
