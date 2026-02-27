---
sidebar_position: 2
---

# Server plugin

Provides HTTP server capabilities with development and production modes.

**Key features:**
- Express server for REST APIs
- Vite dev server with hot module reload
- Static file serving for production
- Remote tunneling to deployed backends

The Server plugin uses the deferred initialization phase to access routes from other plugins.

## What it does

- Starts an Express server (default `host=0.0.0.0`, `port=8000`)
- Mounts plugin routes under `/api/<pluginName>/...`
- Adds `/health` endpoint (returns `{ status: "ok" }`)
- Serves frontend:
  - **Development** (`NODE_ENV=development`): runs a Vite dev server in middleware mode
  - **Production**: auto-detects static frontend directory (checks `dist`, `client/dist`, `build`, `public`, `out`)

## Minimal server example

The smallest valid AppKit server:

```ts
// server/server.ts
import { createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [server()],
});
```

## Manual server start example

When you need to extend Express with custom routes:

```ts
import { createApp, server } from "@databricks/appkit";

const appkit = await createApp({
  plugins: [server({ autoStart: false })],
});

appkit.server.extend((app) => {
  app.get("/custom", (_req, res) => res.json({ ok: true }));
});

await appkit.server.start();
```

## Configuration options

```ts
import { createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [
    server({
      port: 8000,          // default: Number(process.env.DATABRICKS_APP_PORT) || 8000
      host: "0.0.0.0",     // default: process.env.FLASK_RUN_HOST || "0.0.0.0"
      autoStart: true,     // default: true
      staticPath: "dist",  // optional: force a specific static directory
    }),
  ],
});
```
