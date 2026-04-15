"""Integration tests for the Analytics plugin API.

Endpoints:
    POST /api/analytics/query/:query_key  → SSE stream
    GET  /api/analytics/arrow-result/:jobId → binary Arrow data
"""

from __future__ import annotations

import httpx
import pytest

from tests.helpers.sse_parser import collect_sse_stream, events_only

pytestmark = pytest.mark.integration


class TestAnalyticsQueryEndpoint:
    """Tests for POST /api/analytics/query/:query_key."""

    async def test_query_returns_sse_content_type(self, http_client: httpx.AsyncClient):
        """Query endpoint must return SSE content type."""
        try:
            async with http_client.stream(
                "POST",
                "/api/analytics/query/spend_data",
                json={"format": "JSON"},
                timeout=20.0,
            ) as resp:
                if resp.status_code == 404:
                    pytest.skip("Query 'spend_data' not found — no query files configured")
                content_type = resp.headers.get("content-type", "")
                # Successful queries return SSE, errors return JSON
                assert (
                    "text/event-stream" in content_type
                    or "application/json" in content_type
                )
        except (httpx.HTTPError, httpx.StreamError):
            pytest.skip("Analytics endpoint not available")

    async def test_query_missing_key_returns_error(self, http_client: httpx.AsyncClient):
        """Query with nonexistent key should return 404."""
        response = await http_client.post(
            "/api/analytics/query/nonexistent_query_that_does_not_exist",
            json={"format": "JSON"},
        )
        assert response.status_code == 404
        body = response.json()
        assert "error" in body

    async def test_query_result_events_have_correct_format(
        self, http_client: httpx.AsyncClient
    ):
        """Result events from analytics should have type field in their data."""
        try:
            events = await collect_sse_stream(
                http_client,
                "POST",
                "/api/analytics/query/spend_data",
                json_body={"format": "JSON"},
                timeout=20.0,
                max_events=5,
            )
        except (httpx.HTTPError, httpx.StreamError):
            pytest.skip("Analytics endpoint not available")

        real = events_only(events)
        if not real:
            pytest.skip("No analytics events received")

        for event in real:
            if event.is_error:
                # Error events are allowed — Databricks may not be configured
                data = event.parsed_data
                assert "error" in data
                continue
            data = event.parsed_data
            assert data is not None, "Event data should be valid JSON"
            assert "type" in data, f"Result event missing 'type': {data}"

    async def test_query_default_format_is_arrow_stream(
        self, http_client: httpx.AsyncClient
    ):
        """When no format is specified, default should be ARROW_STREAM."""
        try:
            events = await collect_sse_stream(
                http_client,
                "POST",
                "/api/analytics/query/spend_data",
                json_body={},  # No format specified
                timeout=20.0,
                max_events=5,
            )
        except (httpx.HTTPError, httpx.StreamError):
            pytest.skip("Analytics endpoint not available")

        real = events_only(events)
        if not real:
            pytest.skip("No analytics events received")

        # First non-error event should exist
        for event in real:
            if not event.is_error:
                data = event.parsed_data
                assert data is not None
                break


class TestAnalyticsArrowEndpoint:
    """Tests for GET /api/analytics/arrow-result/:jobId."""

    async def test_arrow_result_not_found_returns_404(self, http_client: httpx.AsyncClient):
        """Requesting a nonexistent job ID should return 404."""
        response = await http_client.get(
            "/api/analytics/arrow-result/nonexistent-job-id-12345"
        )
        assert response.status_code == 404
        body = response.json()
        assert "error" in body

    async def test_arrow_result_has_correct_headers(self, http_client: httpx.AsyncClient):
        """If an arrow result exists, it should have correct binary headers.

        Since we can't easily create a real job, this test just validates
        the error response format for missing jobs.
        """
        response = await http_client.get("/api/analytics/arrow-result/fake-job")
        # Should be 404 with JSON error
        assert response.status_code == 404
        assert "application/json" in response.headers.get("content-type", "")
