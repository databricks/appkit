# AppKit

Build Databricks Apps faster with a Node.js + React SDK. Built for humans and AI.

AppKit is a TypeScript SDK for building production-ready Databricks applications with a plugin-based architecture. It gives you opinionated defaults, built-in observability, and first-class integration with Databricks services — so you spend time on your app, not the plumbing.

- **Plugin architecture** — Compose your app from focused plugins; a base server plus analytics, Genie, files, and more.
- **Type safety** — End-to-end TypeScript with automatic query type generation.
- **Production-ready** — Built-in caching, telemetry, retries, and error handling.
- **Great DX** — Hot reload, file-based queries, and a workflow tuned for AI-assisted development.
- **Databricks native** — SQL Warehouses, Unity Catalog, Lakebase, and other workspace resources out of the box.

## Quickstart

Requires the Databricks CLI and Node.js.

**AI-assisted (recommended)** — scaffold and evolve your app by prompting an AI assistant. Install the Agent Skills once:

```sh
databricks aitools install
```

Then ask your assistant to build the app, e.g. _"Create a Databricks app that shows a dashboard of the NYC taxi trips dataset."_ See the [AI-assisted development](https://developers.databricks.com/docs/appkit/v0/development/ai-assisted-development) guide.

**Manual** — scaffold and deploy with the CLI directly:

```sh
databricks apps init      # scaffold the app + install dependencies (follow the prompts)
databricks apps deploy     # deploy to your workspace
```

## What an app looks like

Every app is a set of plugins hosted by `server()`:

```ts
import { createApp, server, analytics } from '@databricks/appkit';

createApp({
  plugins: [server(), analytics()],
});
```

With `analytics()`, drop a `.sql` file in `config/queries/` and it's served at `POST /api/analytics/query/<query_key>` — parameterized, cached, and (with a `.obo.sql` name) executed on behalf of the signed-in user.

## Plugins

AppKit's power comes from its plugin system. Each plugin adds a focused capability with minimal configuration.

- **Server Plugin** — The base Express host that every app includes; other plugins inject their routes into it.
- **Analytics Plugin** — Query your Lakehouse from your app. Define SQL as files, execute against Databricks SQL Warehouses, and get caching, parameterization, and on-behalf-of user execution for free.
- **Genie Plugin** — A conversational AI interface powered by Databricks AI/BI Genie. Let users ask natural-language questions of your data, with automatic chart inference.
- **Files Plugin** — Browse, upload, and manage files in Unity Catalog Volumes, with multiple volumes, content-type validation, and on-behalf-of access.
- **Lakebase Plugin** — OLTP operations against Databricks Lakebase with automatic OAuth token management. Returns a standard `pg.Pool` compatible with Prisma, Drizzle, TypeORM, and other ORMs.

More plugins — including `agents`, `ai-search`, and `database` — are available in beta from `@databricks/appkit/beta`.

> Missing a plugin? [Open an issue](https://github.com/databricks/appkit/issues/new) and tell us what you need — community input directly shapes the roadmap.

## Documentation

- **[AppKit documentation](https://developers.databricks.com/docs/appkit/v0/)** — getting started, guides, and full API reference.
- **[AI-assisted development](https://developers.databricks.com/docs/appkit/v0/development/ai-assisted-development)** — build and evolve apps with an AI assistant.
- New to the Databricks Apps platform? Start with the [Apps quickstart](https://developers.databricks.com/docs/apps/quickstart).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.
