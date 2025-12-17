# CLAUDE.md - @databricks/app-kit

AI assistant guidance for the Databricks AppKit backend SDK.

## Overview

`@databricks/app-kit` is a modular TypeScript SDK for building Databricks applications with a plugin-based architecture. It provides a unified way to create backend services with built-in support for analytics, streaming, caching, and telemetry.

## Core Pattern

Always use `createApp` to initialize the SDK with plugins:

```typescript
import { createApp, server, analytics } from "@databricks/app-kit";

const AppKit = await createApp({
  plugins: [
    server({ port: 8000 }),
    analytics(),
  ],
});
```

After initialization, plugins are accessible via `AppKit[pluginName]`.

## Built-in Plugins

### Server Plugin

Starts an Express server with automatic frontend serving:

```typescript
import { createApp, server } from "@databricks/app-kit";

// Auto-start (default)
await createApp({
  plugins: [server({ port: 8000 })],
});

// Manual start for custom routes
const AppKit = await createApp({
  plugins: [server({ port: 8000, autoStart: false })],
});

const app = await AppKit.server.start();
app.get("/custom", (req, res) => res.json({ ok: true }));
```

**Configuration Options:**
- `port`: Server port (default: 8000 or `DATABRICKS_APP_PORT`)
- `host`: Server host (default: "0.0.0.0" or `FLASK_RUN_HOST`)
- `autoStart`: Auto-start server on init (default: true)
- `staticPath`: Path to static files (auto-detected if not set)

### Analytics Plugin

Execute SQL queries against Databricks SQL Warehouse:

```typescript
import { createApp, server, analytics } from "@databricks/app-kit";

await createApp({
  plugins: [
    server({ port: 8000 }),
    analytics(),
  ],
});
```

**Endpoints:**
- `POST /api/analytics/query/:query_key` - Execute query as service principal
- `POST /api/analytics/users/me/query/:query_key` - Execute query as user (token passthrough)

**Query Files:**
Store SQL queries in `config/queries/<query_key>.sql`. Use parameterized queries:

```sql
-- config/queries/user_activity.sql
SELECT * FROM users WHERE created_at > :start_date AND status = :status
```

**Request Body:**
```json
{
  "parameters": {
    "start_date": "2024-01-01",
    "status": "active"
  }
}
```

## Creating Custom Plugins

Extend the `Plugin` class to create custom functionality:

```typescript
import { Plugin, toPlugin } from "@databricks/app-kit";
import type express from "express";

interface WeatherConfig {
  apiKey?: string;
}

class WeatherPlugin extends Plugin<WeatherConfig> {
  name = "weather";
  protected envVars = ["WEATHER_API_KEY"]; // Required env vars

  async getWeather(city: string): Promise<any> {
    // Use this.execute() for interceptor support (cache, retry, timeout)
    return this.execute(
      async (signal) => {
        const response = await fetch(`https://api.weather.com/${city}`, { signal });
        return response.json();
      },
      {
        default: {
          cache: { enabled: true, cacheKey: ["weather", city], ttl: 300000 },
          retry: { enabled: true, attempts: 3 },
          timeout: 5000,
        },
      },
      city, // userKey for cache scoping
    );
  }

  // Register HTTP routes (scoped to /api/weather/*)
  injectRoutes(router: express.Router) {
    router.get("/:city", async (req, res) => {
      const data = await this.getWeather(req.params.city);
      res.json(data);
    });
  }
}

export const weather = toPlugin<typeof WeatherPlugin, WeatherConfig, "weather">(
  WeatherPlugin,
  "weather"
);
```

**Usage:**
```typescript
import { createApp, server } from "@databricks/app-kit";
import { weather } from "./weather-plugin";

const AppKit = await createApp({
  plugins: [
    server({ port: 8000 }),
    weather({ apiKey: "..." }),
  ],
});

// Direct access
const data = await AppKit.weather.getWeather("Seattle");
```

## Execution Interceptors

Plugins use `execute()` or `executeStream()` which apply interceptors in order:

1. **TelemetryInterceptor** - Traces execution span
2. **TimeoutInterceptor** - AbortSignal timeout
3. **RetryInterceptor** - Exponential backoff retry
4. **CacheInterceptor** - TTL-based caching

```typescript
await this.execute(
  async (signal) => expensiveOperation(signal),
  {
    default: {
      cache: { enabled: true, cacheKey: ["op", id], ttl: 60000 },
      retry: { enabled: true, attempts: 3, delay: 1000 },
      timeout: 5000,
      telemetryInterceptor: { enabled: true },
    },
  },
  userKey,
);
```

## SSE Streaming

For Server-Sent Events streaming with automatic reconnection:

```typescript
class MyPlugin extends Plugin {
  injectRoutes(router: express.Router) {
    router.get("/stream", async (req, res) => {
      await this.executeStream(
        res,
        async function* (signal) {
          for (let i = 0; i < 10; i++) {
            if (signal?.aborted) break;
            yield { type: "progress", data: i };
            await new Promise(r => setTimeout(r, 1000));
          }
          yield { type: "complete", data: "done" };
        },
        { stream: { streamId: req.query.streamId } },
        "user-key",
      );
    });
  }
}
```

**Stream Features:**
- Connection ID-based tracking
- Event ring buffer for reconnection replay
- Automatic heartbeat
- Per-stream abort signals

## Telemetry (OpenTelemetry)

Enable traces, metrics, and logs:

```typescript
await createApp({
  plugins: [server(), analytics()],
  telemetry: {
    traces: true,
    metrics: true,
    logs: true,
  },
});
```

**Environment Variables:**
- `OTEL_EXPORTER_OTLP_ENDPOINT` - OpenTelemetry collector endpoint

## Caching

Configure global cache settings:

```typescript
await createApp({
  plugins: [...],
  cache: {
    type: "memory",  // or "persistent"
    maxSize: 1000,
    defaultTTL: 300000,
  },
});
```

## Type Generation

Generate TypeScript types from SQL queries using the Vite plugin:

```typescript
// vite.config.ts
import { appKitTypesPlugin } from "@databricks/app-kit";

export default {
  plugins: [appKitTypesPlugin()],
};
```

## Style Guidelines

- Always use async/await (never `.then()` chaining)
- Always initialize with `createApp()` before using plugins
- Use ESModules (`import`/`export`), not `require()`
- Store SQL in `config/queries/*.sql`, never inline
- Use parameterized queries for all user input

## Anti-Patterns

- Do not access AppKit internals (only use `AppKit[pluginName]`)
- Do not call plugin methods before `createApp()` resolves
- Do not use `.then()` chaining in examples
- Do not hardcode SQL queries in TypeScript files
- Do not bypass `execute()`/`executeStream()` for operations that need interceptors

