# API reference

This section contains the API reference for the AppKit packages.

## Modules

- [`appkit`](appkit/index.md) - Core library. Provides the core functionality for building Databricks applications.
- [`appkit-ui`](appkit-ui/index.md) - UI components library. Provides a set of UI primitives for building Databricks apps in [React](https://react.dev/).
- [`appkit` (Python)](appkit-python/index.md) - Python SDK for building Databricks apps that use the same plugin model as the Node.js library.

Learn more about the architecture of AppKit in the [architecture](../architecture.md) document.

## Getting started

To learn how to get started with AppKit, see the [getting started guide](../index.md) for AI-assisted and manual quick start options.

## Installation

To install the AppKit packages into your existing JavaScript/TypeScript project, use `npm` or your package manager of choice:

```bash
npm install @databricks/appkit
npm install @databricks/appkit-ui
```

For the Python SDK, install `appkit-rs` with [uv](https://docs.astral.sh/uv/):

```bash
uv add appkit-rs
```
