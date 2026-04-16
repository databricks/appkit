"""Tests for the example plugin.

Run with: pytest
(Requires appkit-rs to be installed: maturin develop or pip install appkit-rs)
"""

import json
import sys
from pathlib import Path

import pytest

import appkit

# Allow importing from server/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from example_plugin import ExamplePlugin


@pytest.fixture
def app_config():
    """Minimal AppConfig for testing (no real Databricks connection)."""
    return appkit.AppConfig(
        "https://test.databricks.com",
        client_id="test-client-id",
        client_secret="test-client-secret",
    )


@pytest.fixture
def example_plugin():
    return ExamplePlugin()


class TestExamplePluginRegistration:
    def test_plugin_name(self, example_plugin):
        assert example_plugin.name == "example"

    def test_plugin_phase(self, example_plugin):
        assert example_plugin.phase == "normal"

    def test_manifest_fields(self, example_plugin):
        m = example_plugin.manifest
        assert m.name == "example"
        assert m.display_name == "Example Plugin"
        assert m.description is not None


class TestExamplePluginLifecycle:
    @pytest.mark.asyncio
    async def test_setup_marks_ready(self, app_config, example_plugin):
        app = await appkit.create_app(
            config=app_config,
            plugins=[example_plugin],
            auto_start=False,
        )
        assert example_plugin.is_ready is True
        assert "example" in app

    @pytest.mark.asyncio
    async def test_execute_greet(self, app_config, example_plugin):
        """Verify the greeting logic works through the interceptor chain."""
        await appkit.create_app(
            config=app_config,
            plugins=[example_plugin],
            auto_start=False,
        )

        async def greet():
            return json.dumps({"message": "Hello, Test!"})

        result = await example_plugin.execute(
            greet,
            user_key="test",
            cache_key=["greet", "test"],
            cache_ttl=60,
        )
        assert result.ok is True
        data = json.loads(result.data)
        assert data["message"] == "Hello, Test!"

    @pytest.mark.asyncio
    async def test_execute_stream(self, app_config, example_plugin):
        """Verify streaming execution collects all chunks."""
        await appkit.create_app(
            config=app_config,
            plugins=[example_plugin],
            auto_start=False,
        )

        async def generate():
            for i in range(3):
                yield json.dumps({"i": i})

        stream = await example_plugin.execute_stream(generate)
        items = []
        async for chunk in stream:
            items.append(json.loads(chunk))
        assert len(items) == 3
        assert items[0]["i"] == 0
        assert items[2]["i"] == 2

    @pytest.mark.asyncio
    async def test_execute_error_handling(self, app_config, example_plugin):
        """Verify errors are captured as failed ExecutionResult."""
        await appkit.create_app(
            config=app_config,
            plugins=[example_plugin],
            auto_start=False,
        )

        async def fail():
            raise ValueError("boom")

        result = await example_plugin.execute(fail)
        assert result.ok is False
        assert "boom" in result.message
