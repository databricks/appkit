# Plugins

Plugins are the building blocks of App Kit applications. They extend functionality while maintaining clean separation of concerns and providing access to shared services.

## What are Plugins?

Plugins are modular extensions that add capabilities to your App Kit application. Each plugin:

- Extends the base `Plugin` class
- Has access to shared services (cache, telemetry, streaming)
- Can inject custom routes into the Express server
- Follows a defined lifecycle (setup, ready, shutdown)
- Can be configured with type-safe options

## Built-in Plugins

### Server Plugin

The Server Plugin provides HTTP server capabilities with development and production modes.

**Features:**
- Express server for REST APIs
- Vite dev server with hot module reload
- Static file serving for production
- Remote tunneling to deployed backends

**Configuration:**

```typescript
import { createApp, server } from "@databricks/app-kit";

await createApp({
  plugins: [
    server({
      port: 8000,              // Server port
      host: "0.0.0.0",         // Bind address
      autoStart: true,         // Start immediately
    }),
  ],
});
```

**Usage:**

```typescript
// With autoStart: false
const AppKit = await createApp({
  plugins: [
    server({ autoStart: false }),
  ],
});

// Manually start and add custom routes
const app = await AppKit.server.start();
app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});
```

**Phase:** Deferred (initializes last, has access to other plugins)

### Analytics Plugin

The Analytics Plugin enables SQL query execution against Databricks SQL Warehouses.

**Features:**
- File-based SQL queries with type generation
- Parameterized queries with SQL type helpers
- JSON and Arrow format support
- Automatic caching and retry logic
- Server-Sent Events (SSE) streaming

**Configuration:**

```typescript
import { createApp, analytics } from "@databricks/app-kit";

await createApp({
  plugins: [
    analytics({
      timeout: 30000,  // Query timeout in ms
    }),
  ],
});
```

**File-based Queries:**

Store queries in `config/queries/`:

```sql
-- config/queries/users.sql
SELECT 
  id,
  name,
  email,
  created_at
FROM main.default.users
WHERE created_at > :startDate
  AND status = :status;
```

**Type-safe Parameters:**

Use SQL helpers for type safety:

```typescript
import { sql } from "@databricks/app-kit";

const parameters = {
  startDate: sql.date("2024-01-01"),
  status: sql.string("active"),
};
```

**Available SQL Helpers:**
- `sql.string(value)`: STRING type
- `sql.number(value)`: NUMERIC type
- `sql.boolean(value)`: BOOLEAN type
- `sql.date(value)`: DATE type
- `sql.timestamp(value)`: TIMESTAMP type
- `sql.binary(value)`: BINARY as hex-encoded STRING

**React Integration:**

```typescript
import { useAnalyticsQuery } from "@databricks/app-kit-ui/react";

function UsersList() {
  const { data, loading, error } = useAnalyticsQuery({
    queryKey: "users",
    parameters: {
      startDate: "2024-01-01",
      status: "active",
    },
    format: "JSON", // or "ARROW"
  });

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <ul>
      {data?.map((user) => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  );
}
```

**Phase:** Normal (default initialization)

## Using Plugins

### Configuration

Plugins are configured when creating the App Kit instance:

```typescript
import { createApp, server, analytics } from "@databricks/app-kit";

const AppKit = await createApp({
  plugins: [
    server({ port: 8000 }),
    analytics({ timeout: 30000 }),
  ],
  cache: {
    enabled: true,
    ttl: 3600,
  },
  telemetry: {
    traces: true,
    metrics: true,
  },
});
```

### Accessing Plugin APIs

Access plugins via the returned AppKit instance:

```typescript
// Access server plugin
const app = await AppKit.server.start();

// Access analytics plugin (if needed for advanced use cases)
const result = await AppKit.analytics.query(
  "SELECT * FROM table",
  { id: sql.number(123) }
);
```

## Creating Custom Plugins

### Basic Plugin Structure

Create a custom plugin by extending the `Plugin` class:

```typescript
import { Plugin, toPlugin } from "@databricks/app-kit";
import type { IAppRouter } from "@databricks/app-kit";

// Define plugin config interface
interface MyPluginConfig {
  apiKey?: string;
  timeout?: number;
}

// Extend Plugin class
export class MyPlugin extends Plugin<MyPluginConfig> {
  name = "myPlugin";
  envVars = ["MY_API_KEY"]; // Required env vars

  // Inject routes into Express
  injectRoutes(router: IAppRouter): void {
    this.route(router, {
      method: "get",
      path: "/my-endpoint",
      handler: async (req, res) => {
        res.json({ message: "Hello from my plugin!" });
      },
    });
  }

  // Optional: Async setup
  async setup() {
    console.log("MyPlugin initialized");
  }

  // Optional: Cleanup
  async shutdown() {
    console.log("MyPlugin shutting down");
  }
}

// Export type-safe factory function
export const myPlugin = toPlugin<
  typeof MyPlugin,
  MyPluginConfig,
  "myPlugin"
>(MyPlugin, "myPlugin");
```

### Using Your Custom Plugin

```typescript
import { createApp, server } from "@databricks/app-kit";
import { myPlugin } from "./my-plugin";

const AppKit = await createApp({
  plugins: [
    server(),
    myPlugin({ apiKey: "secret", timeout: 5000 }),
  ],
});

// Access your plugin
AppKit.myPlugin; // Fully typed!
```

### Advanced Plugin Example

Plugin with streaming, caching, and telemetry:

```typescript
import { Plugin, toPlugin } from "@databricks/app-kit";
import type { IAppRouter, StreamExecutionSettings } from "@databricks/app-kit";

interface DataPluginConfig {
  batchSize?: number;
}

export class DataPlugin extends Plugin<DataPluginConfig> {
  name = "data";
  envVars = [];

  injectRoutes(router: IAppRouter): void {
    this.route(router, {
      method: "get",
      path: "/stream-data",
      handler: async (req, res) => {
        const userId = req.query.userId as string;

        const streamSettings: StreamExecutionSettings = {
          default: {
            cache: {
              enabled: true,
              cacheKey: ["data", userId],
              ttl: 300,
            },
            retry: {
              enabled: true,
              attempts: 3,
            },
            timeout: 30000,
          },
          stream: {
            streamId: `data-${userId}`,
            bufferSize: 100,
          },
        };

        await this.executeStream(
          res,
          async function* (signal) {
            // Generator function for streaming
            for (let i = 0; i < 10; i++) {
              if (signal?.aborted) break;

              yield {
                index: i,
                data: `Item ${i}`,
                timestamp: new Date().toISOString(),
              };

              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          },
          streamSettings,
          userId,
        );
      },
    });
  }
}

export const dataPlugin = toPlugin<
  typeof DataPlugin,
  DataPluginConfig,
  "data"
>(DataPlugin, "data");
```

## Plugin Phases

Plugins initialize in three phases, allowing control over initialization order:

### Core Phase

Reserved for future framework-level plugins. Initializes first.

```typescript
export class CorePlugin extends Plugin {
  static phase = "core";
  // ...
}
```

### Normal Phase

Default phase for most plugins. Initializes after core plugins.

```typescript
export class NormalPlugin extends Plugin {
  static phase = "normal"; // or omit (default)
  // ...
}
```

### Deferred Phase

Initializes last. Has access to other plugin instances via `config.plugins`.

```typescript
export class DeferredPlugin extends Plugin {
  static phase = "deferred";

  constructor(config) {
    super(config);
    // Access other plugins via config.plugins
    const otherPlugin = config.plugins?.otherPlugin;
  }
}
```

**Example:** The Server Plugin uses deferred phase to access analytics routes.

## Plugin Capabilities

### Built-in Services

All plugins have access to shared services:

```typescript
export class MyPlugin extends Plugin {
  async myMethod() {
    // Cache management
    const cached = await this.cache.get("key");
    await this.cache.set("key", value);

    // Telemetry
    const span = this.telemetry.startSpan("operation");
    span.end();

    // Stream management
    await this.streamManager.stream(res, generator);

    // App metadata
    const query = await this.app.getAppQuery("queryKey", req);
  }
}
```

### Execution Interceptors

Use `execute()` or `executeStream()` for automatic interceptor wrapping:

```typescript
// Single execution with interceptors
const result = await this.execute(
  () => fetchData(),
  {
    default: {
      timeout: 10000,
      retry: { enabled: true, attempts: 3 },
      cache: { enabled: true, cacheKey: ["data"] },
    },
  },
  userKey,
);

// Streaming execution with interceptors
await this.executeStream(
  res,
  async function* () {
    yield* generateData();
  },
  {
    default: { /* interceptor config */ },
    stream: { streamId: "my-stream" },
  },
  userKey,
);
```

### Route Injection

Add custom routes to the Express server:

```typescript
injectRoutes(router: IAppRouter): void {
  // Simple route
  this.route(router, {
    method: "get",
    path: "/hello",
    handler: async (req, res) => {
      res.json({ message: "Hello!" });
    },
  });

  // Route with response type (for type generation)
  this.route<{ users: User[] }>(router, {
    method: "post",
    path: "/users",
    handler: async (req, res) => {
      const users = await fetchUsers();
      res.json({ users });
    },
  });
}
```

### Lifecycle Hooks

Override lifecycle methods for custom behavior:

```typescript
export class MyPlugin extends Plugin {
  // Validate required environment variables
  validateEnv() {
    super.validateEnv();
    // Custom validation
  }

  // Async initialization
  async setup() {
    await this.initializeConnections();
  }

  // Cleanup on shutdown
  async shutdown() {
    await this.closeConnections();
  }
}
```

## Best Practices

1. **Use Type-Safe Factories**: Always use `toPlugin()` for type inference
2. **Declare Environment Variables**: List required env vars in `envVars` array
3. **Leverage Interceptors**: Use `execute()` and `executeStream()` for built-in resilience
4. **Choose the Right Phase**: Use deferred phase only when you need access to other plugins
5. **Clean Up Resources**: Implement `shutdown()` for proper cleanup
6. **Document Configuration**: Provide clear TypeScript interfaces for plugin config
