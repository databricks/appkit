# appkit (Python SDK)

Python SDK for Databricks AppKit. Provides the same plugin-based application framework as the TypeScript `@databricks/appkit` SDK, targeting Python backend applications.

## Status

**Prototype** — the API is functional but may change. Not yet published to PyPI.

## Prerequisites

- **Rust toolchain** — install via [rustup](https://rustup.rs/)
- **Python 3.11+**
- **[maturin](https://www.maturin.rs/)** — `pip install maturin`

## Local Build

```bash
# Development (debug build, installed into current venv)
cd packages/appkit-rs
maturin develop

# Production wheel
maturin build --release
```

The built wheel is written to `target/wheels/`.

## Running Tests

```bash
# Rust unit tests
cargo test

# Python integration tests (requires maturin develop first)
pytest
```

## Wheel Bundling

For prototyping or sharing pre-built wheels without PyPI:

```bash
maturin build --release --manylinux 2_28
```

Then reference the wheel from a `requirements.txt`:

```
databricks_appkit @ file:///path/to/appkit-0.1.0-cp311-cp311-manylinux_2_28_x86_64.whl
```

## CI

The [`build-wheels.yml`](../../.github/workflows/build-wheels.yml) workflow builds wheels for:

- **Linux**: x86_64 and aarch64 (manylinux 2_28)
- **macOS**: x86_64 and aarch64

It runs on pushes to `main` and on pull requests that touch `packages/appkit-rs/**`. A publish step is gated on `appkit-py-v*` tags.

## Deployment Gotchas

### Cross-compilation for Databricks Apps

Databricks Apps runs on x86_64 Linux with Python 3.11. If you're building on macOS (or a different arch), you need to cross-compile the native extension. Two approaches:

1. **Build on a Linux x86_64 machine** (simplest):
   ```bash
   PYO3_PYTHON=python3.11 cargo build --release --lib
   strip target/release/libappkit.so
   cp target/release/libappkit.so appkit/appkit.cpython-311-x86_64-linux-gnu.so
   ```

2. **Use maturin with zig** (from macOS):
   ```bash
   pip install 'maturin[zig]'
   maturin build --release --target x86_64-unknown-linux-gnu --zig
   ```

### Deploying without PyPI

Since the SDK isn't published yet, deploy the native extension directly alongside your app code:

```
your-app/
├── app.yaml
├── server/
│   ├── __init__.py
│   └── app.py
└── appkit/              # SDK files copied into your app
    ├── __init__.py
    ├── _context.py
    ├── appkit.cpython-311-x86_64-linux-gnu.so
    └── plugins/
        ├── __init__.py
        └── ...
```

Upload to workspace and deploy:
```bash
databricks workspace import-dir ./your-app /Workspace/Users/<you>/my-app --overwrite
databricks apps deploy my-app --source-code-path /Workspace/Users/<you>/my-app
```

### SIGTERM handling

Databricks Apps sends SIGTERM with a 15-second grace period on redeployment. The default `asyncio.Event().wait()` pattern in app entry points doesn't handle SIGTERM within that window. Consider adding a signal handler:

```python
import signal

stop = asyncio.Event()
loop = asyncio.get_running_loop()
for sig in (signal.SIGTERM, signal.SIGINT):
    loop.add_signal_handler(sig, stop.set)

await stop.wait()
app.shutdown()
```

## Getting Started

See the [Python template](../../template-python/) for a runnable scaffold that uses `appkit` to build a backend application with plugins, routes, caching, and streaming.
