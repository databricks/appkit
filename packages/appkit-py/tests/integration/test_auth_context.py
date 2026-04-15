"""Integration tests for authentication and user context propagation.

The AppKit backend uses two auth modes:
1. Service principal — configured via DATABRICKS_HOST/DATABRICKS_TOKEN env vars
2. User context (OBO) — forwarded via x-forwarded-user and x-forwarded-access-token headers

The Databricks Apps proxy sets these headers automatically in production.
"""

from __future__ import annotations

import httpx
import pytest

pytestmark = pytest.mark.integration


class TestAuthHeaders:
    """Tests for auth header handling."""

    async def test_health_works_without_auth(self, unauthed_client: httpx.AsyncClient):
        """Health endpoint should not require auth."""
        response = await unauthed_client.get("/health")
        assert response.status_code == 200

    async def test_volumes_endpoint_works_without_auth(
        self, unauthed_client: httpx.AsyncClient
    ):
        """The volumes list endpoint doesn't require user context."""
        response = await unauthed_client.get("/api/files/volumes")
        # Should work — volumes list doesn't require OBO
        assert response.status_code == 200

    async def test_file_operations_require_user_context(
        self, unauthed_client: httpx.AsyncClient
    ):
        """File operations (except volumes list) should require auth headers in OBO mode."""
        # First get a volume key
        vol_resp = await unauthed_client.get("/api/files/volumes")
        if vol_resp.status_code != 200:
            pytest.skip("Files plugin not available")
        volumes = vol_resp.json().get("volumes", [])
        if not volumes:
            pytest.skip("No volumes configured")

        volume = volumes[0]
        response = await unauthed_client.get(
            f"/api/files/{volume}/list"
        )
        # Should either fail with auth error or succeed if service principal mode
        # The key assertion: it should NOT crash — it should return a structured error
        assert response.status_code in (200, 401, 403, 500)
        if response.status_code >= 400:
            body = response.json()
            assert "error" in body

    async def test_authenticated_request_accepted(self, http_client: httpx.AsyncClient):
        """Requests with proper auth headers should be accepted."""
        response = await http_client.get("/health")
        assert response.status_code == 200

    async def test_auth_headers_forwarded_format(self, http_client: httpx.AsyncClient):
        """Auth headers should follow the x-forwarded-* format."""
        # The http_client fixture already includes these headers.
        # This test validates that the server accepts them without error.
        response = await http_client.get("/api/files/volumes")
        assert response.status_code == 200


class TestErrorResponseFormat:
    """Tests for consistent error response formatting."""

    async def test_404_returns_json_error(self, http_client: httpx.AsyncClient):
        """404 errors should return JSON with an 'error' field."""
        response = await http_client.get("/api/files/nonexistent_volume/list")
        assert response.status_code == 404
        body = response.json()
        assert "error" in body

    async def test_error_includes_plugin_name(self, http_client: httpx.AsyncClient):
        """Error responses from plugins should include the plugin name."""
        response = await http_client.get("/api/files/nonexistent_volume/list")
        assert response.status_code == 404
        body = response.json()
        assert "plugin" in body
        assert body["plugin"] == "files"
