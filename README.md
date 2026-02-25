# AppKit

Build Databricks Apps faster with our brand-new Node.js + React SDK. Built for humans and AI.

> [!WARNING]  
> PREVIEW - NOT FOR PRODUCTION USE

> **This SDK is in preview and is subject to change without notice.**
>
> - ❌ **Do NOT use in production environments**
> - ⚠️ **Breaking changes may occur at any time**
> - 🔬 **APIs are experimental and unstable**
> - 📝 **Use for development and testing only**
>

## Introduction

AppKit is a TypeScript SDK for building production-ready Databricks applications with a plugin-based architecture. It provides opinionated defaults, built-in observability, and seamless integration with Databricks services.

AppKit simplifies building data applications on Databricks by providing:

- **Plugin architecture**: Modular design with built-in server and analytics plugins
- **Type safety**: End-to-end TypeScript with automatic query type generation
- **Production-ready features**: Built-in caching, telemetry, retry logic, and error handling
- **Developer experience**: Remote hot reload, file-based queries, optimized for AI-assisted development
- **Databricks native**: Seamless integration with SQL Warehouses, Unity Catalog, and other workspace resources

## Plugins

AppKit's power comes from its plugin system. Each plugin adds a focused capability to your app with minimal configuration.

### Available now

- **Analytics Plugin** — Query your Lakehouse data directly from your app. Define SQL queries as files, execute them against Databricks SQL Warehouses, and get automatic caching, parameterization, and on-behalf-of user execution out of the box. Perfect for building apps that surface insights from your Lakehouse.

### Coming soon

- **Genie Plugin** — Conversational AI interface powered by Databricks Genie
- **Files Plugin** — Browse, upload, and manage files in Unity Catalog Volumes
- **Lakebase Plugin** — OLTP database operations with automatic OAuth token management
- ...and this is just the beginning.

> Missing a plugin? [Open an issue](https://github.com/databricks/appkit/issues/new) and tell us what you need — community input directly shapes the roadmap.

## Getting started

Follow the [Getting Started](https://databricks.github.io/appkit/docs/) guide to get started with AppKit.

🤖 For AI/code assistants, see the [AI-assisted development](https://databricks.github.io/appkit/docs/development/ai-assisted-development) guide.

## Documentation

📖 For full AppKit documentation, visit the [AppKit Documentation](https://databricks.github.io/appkit/) website.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.
