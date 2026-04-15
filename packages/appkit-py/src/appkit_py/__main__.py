"""Entry point for running the AppKit Python backend with `python -m appkit_py`."""

import os

from dotenv import load_dotenv


def main() -> None:
    load_dotenv()

    import uvicorn

    from appkit_py.server import create_server

    # Match TS AppKit env vars for compatibility
    host = os.environ.get("FLASK_RUN_HOST", os.environ.get("APPKIT_HOST", "0.0.0.0"))
    port = int(os.environ.get("DATABRICKS_APP_PORT", "8000"))
    log_level = os.environ.get("APPKIT_LOG_LEVEL", "info")

    app = create_server()
    uvicorn.run(app, host=host, port=port, log_level=log_level)


if __name__ == "__main__":
    main()
