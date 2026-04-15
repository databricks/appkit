"""Shared test fixtures for appkit-py tests.

Integration tests are language-agnostic HTTP tests that can run against either
the TypeScript or Python backend. Set APPKIT_TEST_URL to point at the target server.
"""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator

import httpx
import pytest
import pytest_asyncio


@pytest.fixture(scope="session")
def base_url() -> str:
    """Base URL for the backend server under test.

    Set APPKIT_TEST_URL env var to point at TS or Python backend.
    Default: http://localhost:8000
    """
    return os.environ.get("APPKIT_TEST_URL", "http://localhost:8000")


@pytest.fixture(scope="session")
def auth_headers() -> dict[str, str]:
    """Default auth headers simulating Databricks Apps proxy."""
    return {
        "x-forwarded-user": "test-user@databricks.com",
        "x-forwarded-access-token": "fake-obo-token-for-testing",
    }


@pytest.fixture(scope="session")
def no_auth_headers() -> dict[str, str]:
    """Empty headers for testing unauthenticated requests."""
    return {}


@pytest_asyncio.fixture
async def http_client(
    base_url: str, auth_headers: dict[str, str]
) -> AsyncGenerator[httpx.AsyncClient]:
    """Async HTTP client pre-configured with base URL and auth headers."""
    async with httpx.AsyncClient(
        base_url=base_url,
        headers=auth_headers,
        timeout=httpx.Timeout(30.0, connect=10.0),
    ) as client:
        yield client


@pytest_asyncio.fixture
async def unauthed_client(base_url: str) -> AsyncGenerator[httpx.AsyncClient]:
    """Async HTTP client with no auth headers."""
    async with httpx.AsyncClient(
        base_url=base_url,
        timeout=httpx.Timeout(30.0, connect=10.0),
    ) as client:
        yield client
