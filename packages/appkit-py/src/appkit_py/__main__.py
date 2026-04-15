"""Entry point for running the AppKit Python backend with `python -m appkit_py`."""

import os
import uvicorn

from appkit_py.server import create_server


def main() -> None:
    host = os.environ.get("FLASK_RUN_HOST", "0.0.0.0")
    port = int(os.environ.get("DATABRICKS_APP_PORT", "8000"))
    log_level = "info" if os.environ.get("NODE_ENV") != "production" else "warning"

    app = create_server()
    uvicorn.run(app, host=host, port=port, log_level=log_level)


if __name__ == "__main__":
    main()
