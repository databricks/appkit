"""Entry point for the AppKit Python application."""

import asyncio
from pathlib import Path

import appkit
from dotenv import load_dotenv

from example_plugin import ExamplePlugin

# Load .env from the template-python root (one level up from server/).
load_dotenv(Path(__file__).resolve().parent.parent / ".env")


async def main():
    config = appkit.AppConfig.from_env()

    app = await appkit.create_app(
        config=config,
        plugins=[ExamplePlugin()],
        cache_config=appkit.CacheConfig(ttl=3600),
    )

    # The server starts automatically (auto_start=True by default).
    # To keep the process alive, await shutdown or Ctrl-C.
    print(f"AppKit running on http://{config.host}:{config.app_port}")
    try:
        await asyncio.Event().wait()  # Block until interrupted
    except asyncio.CancelledError:
        pass
    finally:
        app.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
