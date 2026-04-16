"""Shared fixtures for appkit integration tests.

Run with: maturin develop && pytest tests/
"""

import pytest


@pytest.fixture
def app_config():
    """Minimal AppConfig for testing (no real Databricks connection)."""
    import appkit

    return appkit.AppConfig(
        "https://test.databricks.com",
        client_id="test-client-id",
        client_secret="test-client-secret",
        warehouse_id="test-warehouse-id",
    )


@pytest.fixture
def user_context():
    """A sample UserContext for testing."""
    import appkit

    return appkit.UserContext(
        "test-token",
        "user-42",
        user_name="Alice",
        workspace_id="ws-123",
        warehouse_id="wh-456",
    )


@pytest.fixture
def cache_config():
    """CacheConfig with short TTL for testing."""
    import appkit

    return appkit.CacheConfig(ttl=10, max_size=50)
