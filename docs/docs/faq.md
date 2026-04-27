---
sidebar_position: 6
---

# FAQ

## Integrations

### What Databricks services are available through AppKit?

AppKit provides built-in integrations with the following Databricks services via its [plugin system](./plugins/):

| Plugin | Databricks Service | What It Does |
| --- | --- | --- |
| [Analytics](./plugins/analytics) | SQL Warehouses | Execute parameterized SQL queries with built-in caching, retry, and Arrow support |
| [Lakebase](./plugins/lakebase) | Lakebase Autoscaling (PostgreSQL) | Relational database access via standard pg.Pool with automatic OAuth token refresh |
| [Genie](./plugins/genie) | AI/BI Genie Spaces | Natural language data queries with conversation management and streaming |
| [Files](./plugins/files) | Unity Catalog Volumes | Multi-volume file operations (list, read, upload, download, delete, preview) |
| [Model Serving](./plugins/model-serving) | Model Serving | Authenticated proxy to Model Serving endpoints with invoke and streaming support |
| [Server](./plugins/server) | N/A | Express HTTP server with static file serving, Vite dev mode, and plugin route injection |

Stay tuned for new plugins as we constantly expand integrations!

### Can I add custom integrations?

Yes. AppKit's plugin architecture is extensible - you can create custom plugins using the CLI (`npx appkit plugin create`) or manually. See the [creating custom plugins guide](./plugins/custom-plugins).

## Authentication

### How does authentication work in AppKit apps?

AppKit apps are designed to run on [Databricks Apps](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/), which handles user authentication and authorization. Databricks Apps forwards user identity to the app via request headers, and AppKit integrates with this through the `.asUser(req)` pattern for on-behalf-of (OBO) execution — allowing plugins to act on behalf of the authenticated user.

For details on how authentication and authorization work in Databricks Apps, see the [official auth documentation](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth).

## Databases

*Also: Lakebase, PostgreSQL, OLTP*

### How does AppKit handle databases?

AppKit is a TypeScript SDK (Express + React) and does not manage databases directly.

To add database support, use the [Lakebase plugin](./plugins/lakebase), which integrates with Lakebase Autoscaling.

AppKit also uses Lakebase for caching when it is available (see the [caching](#does-appkit-support-caching) section below).

You can manage Lakebase Autoscaling projects and branches using the dedicated agent skill from [Databricks Agent Skills](./development/ai-assisted-development), installed with the Databricks CLI.

### How does database setup and permission management work in AppKit?

AppKit apps can have an attached Lakebase Autoscaling instance. No database is bundled by default - you add one by configuring the [Lakebase plugin](./plugins/lakebase). When running `databricks apps init` and selecting the Lakebase plugin, the selected database is automatically attached as an app resource after deployment.

With [AI-assisted development](./development/ai-assisted-development), you can also ask the Agent to create a Lakebase project and branch for you.

When deployed, a Databricks app uses its Service Principal for schema and table creation. If you configure the Lakebase Autoscaling project as an [app resource](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/resources), the necessary connect and create permissions are granted automatically to the app's Service Principal.

### Does AppKit support Lakebase Provisioned?

No. AppKit only supports Lakebase Autoscaling. Lakebase Provisioned databases are not supported by the [Lakebase plugin](./plugins/lakebase) or Lakebase agent skill from [Databricks Agent Skills](./development/ai-assisted-development).

## Caching

### Does AppKit support caching?

Yes. The [Analytics plugin](./plugins/analytics) - used for executing SQL queries against Databricks SQL Warehouses - supports an optional cache layer.

Caching is configured per plugin and can use either [Lakebase Autoscaling](https://docs.databricks.com/aws/en/oltp/) or an in-memory store, depending on the configuration.

If the Lakebase Autoscaling connection is configured, the AppKit-based app creates an `appkit` schema in the configured database with internal tables required for caching.
