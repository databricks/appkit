"""Integration tests for the /health endpoint.

These tests validate the health check contract that must be identical
between TypeScript and Python backends.
"""

from __future__ import annotations

import httpx
import pytest

pytestmark = pytest.mark.integration


class TestHealthEndpoint:
    async def test_health_returns_200(self, http_client: httpx.AsyncClient):
        response = await http_client.get("/health")
        assert response.status_code == 200

    async def test_health_returns_status_ok(self, http_client: httpx.AsyncClient):
        response = await http_client.get("/health")
        body = response.json()
        assert body == {"status": "ok"}

    async def test_health_content_type_is_json(self, http_client: httpx.AsyncClient):
        response = await http_client.get("/health")
        content_type = response.headers.get("content-type", "")
        assert "application/json" in content_type

    async def test_health_works_without_auth(self, unauthed_client: httpx.AsyncClient):
        """Health endpoint should work without auth headers."""
        response = await unauthed_client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
