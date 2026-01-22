---
sidebar_position: 1
---

# Getting started

import Prerequisites from './_prerequisites.mdx';

## Introduction

AppKit is a TypeScript SDK for building production-ready Databricks applications with a plugin-based architecture. It provides opinionated defaults, built-in observability, and seamless integration with Databricks services.

AppKit simplifies building data applications on Databricks by providing:

- **Plugin architecture**: Modular design with built-in server and analytics plugins
- **Type safety**: End-to-end TypeScript with automatic query type generation
- **Production-ready features**: Built-in caching, telemetry, retry logic, and error handling
- **Developer experience**: Remote hot reload, file-based queries, optimized for AI-assisted development
- **Databricks native**: Seamless integration with SQL Warehouses, Unity Catalog, and other workspace resources

<Prerequisites />

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

Once configured for your development environment, you can use your AI assistant to create and deploy new Databricks applications, as well as to iteratively evolve your app's codebase.

Just prompt your AI assistant to create a new Databricks app, such as:

```
Create a new Databricks app that displays a dashboard of the nyc taxi trips dataset.
```

To learn more about the MCP server, see the [AI-assisted development](./development/ai-assisted-development.mdx) documentation.

## Manual quick start

Learn how to create and deploy a sample Databricks application that uses AppKit with the Databricks CLI.

### Bootstrap a new Databricks app

Run the following command to bootstrap the new Databricks app with AppKit:

```sh
databricks apps init
```

Follow the prompts to bootstrap the app codebase in the current working directory.  

The command will guide you through the process of:
- creating a new Databricks app
- scaffolding the app codebase with selected features
- installing dependencies
- (optionally) deploying the app to Databricks
- (optionally) running the app in development mode

Learn more about the various [development flows](./development/) available with AppKit.

### Deploy the app to Databricks

Run the following command to deploy the app to Databricks:

```sh
databricks apps deploy
```

This deploys the sample app to Databricks.

## Next steps

- **[App management](./app-management.mdx)**: Manage your AppKit application throughout its lifecycle using the Databricks CLI
- **[API reference](./api/appkit/)**: Explore the complete API documentation
- **[Core concepts](./core-principles)**: Learn about AppKit's design principles and architecture
