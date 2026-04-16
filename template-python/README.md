# AppKit Python Template

A minimal, runnable scaffold for Python backend applications built on [appkit](../packages/appkit-rs/).

## Prerequisites

- Python 3.11+
- Rust toolchain (for building from source) — install via [rustup](https://rustup.rs/)
- [maturin](https://www.maturin.rs/) (`pip install maturin`)

## Setup

```bash
# 1. Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate  # Linux/macOS
# .venv\Scripts\activate   # Windows

# 2. Install appkit (build from source)
cd ../packages/appkit-rs
maturin develop
cd ../../template-python

# 3. Install remaining dependencies
pip install -r requirements.txt

# 4. Configure environment
cp .env.example .env
# Edit .env with your Databricks workspace URL and credentials
```

## Run

```bash
python server/main.py
```

The server starts on `http://0.0.0.0:8000` by default. Test it:

```bash
# Health check
curl http://localhost:8000/api/example/health

# Greeting (with caching and timeout via the interceptor chain)
curl -X POST http://localhost:8000/api/example/greet \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice"}'

# Streaming
curl http://localhost:8000/api/example/stream
```

## Test

```bash
pytest
```

Tests exercise plugin registration, the interceptor chain (`execute`), streaming (`execute_stream`), and error handling — all without requiring a live Databricks workspace.

## Project Structure

```
template-python/
├── server/
│   ├── main.py              # Entry point — creates AppConfig, registers plugins, starts server
│   └── example_plugin.py    # Sample Plugin subclass with routes
├── tests/
│   └── test_example.py      # pytest tests for the example plugin
├── pyproject.toml            # Python project metadata
├── requirements.txt          # Pinned dependencies
├── .env.example              # Environment variable documentation
├── app.yaml.tmpl             # Databricks Apps deployment config
├── databricks.yml.tmpl       # Databricks Bundle config
└── README.md                 # This file
```

## Deploy to Databricks

1. Install the [Databricks CLI](https://docs.databricks.com/dev-tools/cli/index.html).
2. Copy the deployment templates:
   ```bash
   cp app.yaml.tmpl app.yaml
   cp databricks.yml.tmpl databricks.yml
   ```
3. Edit `databricks.yml` — set your project name, workspace host, and any resource references.
4. Deploy:
   ```bash
   databricks bundle deploy
   ```

## Customizing

- **Add plugins:** Create a new file in `server/`, subclass `appkit.Plugin`, and register it in `main.py`.
- **Add routes:** Override `inject_routes(self, router)` in your plugin. Routes are automatically namespaced under `/api/{plugin-name}/`.
- **Use connectors:** Access Databricks services via `appkit.SqlWarehouseConnector`, `appkit.FilesConnector`, `appkit.GenieConnector`, `appkit.ServingConnector`, or `appkit.LakebaseConnector`.
- **Caching/retry/timeout:** Pass options to `self.execute()` to leverage the built-in interceptor chain.
