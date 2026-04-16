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

## Getting Started

See the [Python template](../../template-python/) for a runnable scaffold that uses `appkit` to build a backend application with plugins, routes, caching, and streaming.
