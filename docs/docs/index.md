---
sidebar_position: 1
---

# Getting Started

## Introduction

AppKit is a TypeScript SDK for building production-ready Databricks applications with a plugin-based architecture. It provides opinionated defaults, built-in observability, and seamless integration with Databricks services.

AppKit simplifies building data applications on Databricks by providing:

- **Plugin architecture**: Modular design with built-in server and analytics plugins
- **Type safety**: End-to-end TypeScript with automatic query type generation
- **Production-ready features**: Built-in caching, telemetry, retry logic, and error handling
- **Developer experience**: Remote hot reload, file-based queries, optimized for AI-assisted development
- **Databricks native**: Seamless integration with SQL Warehouses, Unity Catalog, and other workspace resources

## Prerequisites

- [Node.js](https://nodejs.org)
- Databricks CLI: install and configure it according to the [official tutorial](https://docs.databricks.com/aws/en/dev-tools/cli/tutorial).

## Quick start options

There are two ways to get started with AppKit:

- **AI-assisted** (recommended): Use an AI coding assistant connected via the Databricks MCP server to explore data, run CLI commands, and scaffold your app interactively.
- **Manual**: Use the Databricks CLI directly to create, bootstrap, and deploy your app.

Choose the path that best fits your workflow; both approaches produce the same kind of AppKit-based Databricks application.

## AI-first quick start

Databricks AppKit is designed to work with AI coding assistants through the Databricks MCP server.

Install the Databricks MCP server and configure it for use with your preferred AI assistant:

```bash
databricks experimental apps-mcp install
```

Once configured for your development environment, you can use your AI assistant to create and deploy new Databricks applications, as well as to iteratively evolve your app’s codebase.

The MCP server exposes the following capabilities:

- **Data exploration**: Query catalogs, schemas, tables, and execute SQL
- **CLI command execution**: Run bundle, apps, and workspace operations
- **Workspace resource discovery**: Inspect and navigate workspace resources

## Manual quick start

Learn how to create and deploy a sample Databricks application that uses AppKit with the Databricks CLI.

### Create a new Databricks app

Run the following command to create a new Databricks application:

```sh
databricks apps create {application-name}
```

This creates a new Databricks application named `{application-name}` in the current workspace.

### Bootstrap the app codebase with AppKit

Run the following command to bootstrap the app codebase:

```sh
databricks experimental appkit init
```

Follow the prompts to bootstrap the app codebase in the current working directory.  
This creates a complete TypeScript project with Tailwind CSS, React, and AppKit installed out of the box.

### Deploy the app to Databricks

Run the following command to deploy the app to Databricks:

```sh
databricks experimental appkit deploy .
```

This deploys the sample app to Databricks.

## Next steps

- **[Core Concepts](./core-concepts/principles)**: Learn about AppKit's design principles and architecture
- **[API Reference](./api/appkit/)**: Explore the complete API documentation
