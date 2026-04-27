---
sidebar_position: 7
---

# Creating custom plugins

If you need custom API routes or background logic, implement an AppKit plugin. The fastest way is to use the CLI:

```bash
# Interactive
npx @databricks/appkit plugin create

# Non-interactive
npx @databricks/appkit plugin create --placement in-repo --path plugins/my-plugin --name my-plugin --description "My plugin" --force
```

For a deeper understanding of the plugin structure, read on.

## Basic plugin example

Extend the [`Plugin`](../api/appkit/Class.Plugin.md) class and export with `toPlugin()`:

```typescript
import { Plugin, toPlugin, type PluginManifest } from "@databricks/appkit";
import type express from "express";

class MyPlugin extends Plugin {
  static manifest = {
    name: "myPlugin",
    displayName: "My Plugin",
    description: "A custom plugin",
    resources: {
      required: [
        {
          type: "secret",
          alias: "apiKey",
          resourceKey: "apiKey",
          description: "API key for external service",
          permission: "READ",
          fields: {
            scope: { env: "MY_SECRET_SCOPE", description: "Secret scope" },
            key: { env: "MY_API_KEY", description: "Secret key name" }
          }
        }
      ],
      optional: []
    }
  } satisfies PluginManifest<"myPlugin">;

  async setup() {
    // Initialize your plugin
  }

  myCustomMethod() {
    // Some implementation
  }

  async shutdown() {
    // Clean up resources
  }

  exports() {
    return {
      myCustomMethod: this.myCustomMethod
    }
  }
}

export const myPlugin = toPlugin(MyPlugin);
```

## Config-dependent resources

The manifest defines resources as either `required` (always needed) or `optional` (may be needed).
For resources that become required based on plugin configuration, implement a static
`getResourceRequirements(config)` method:

```typescript
interface MyPluginConfig extends BasePluginConfig {
  enableCaching?: boolean;
}

class MyPlugin extends Plugin<MyPluginConfig> {
  static manifest = {
    name: "myPlugin",
    displayName: "My Plugin",
    description: "A plugin with optional caching",
    resources: {
      required: [
        { type: "sql_warehouse", alias: "warehouse", resourceKey: "sqlWarehouse", description: "Query execution", permission: "CAN_USE", fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } } }
      ],
      optional: [
        // Listed as optional in manifest for static analysis
        { type: "database", alias: "cache", resourceKey: "cache", description: "Query result caching (if enabled)", permission: "CAN_CONNECT_AND_CREATE", fields: { instance_name: { env: "DATABRICKS_CACHE_INSTANCE" }, database_name: { env: "DATABRICKS_CACHE_DB" } } }
      ]
    }
  } satisfies PluginManifest<"myPlugin">;

  // Runtime: Convert optional resources to required based on config
  static getResourceRequirements(config: MyPluginConfig) {
    const resources = [];
    if (config.enableCaching) {
      // When caching is enabled, Database becomes required
      resources.push({
        type: "database",
        alias: "cache",
        resourceKey: "cache",
        description: "Query result caching",
        permission: "CAN_CONNECT_AND_CREATE",
        fields: {
          instance_name: { env: "DATABRICKS_CACHE_INSTANCE" },
          database_name: { env: "DATABRICKS_CACHE_DB" },
        },
        required: true  // Mark as required at runtime
      });
    }
    return resources;
  }
}
```

This pattern allows:
- **Static tools** (CLI, docs) to show all possible resources
- **Runtime validation** to enforce resources based on actual configuration

## Validating request bodies

When registering a route via `this.route()`, provide a `body` schema to validate `req.body` before the handler runs. The framework accepts any validator that implements the [Standard Schema](https://standardschema.dev) v1 contract — Zod 3.24+, Valibot, ArkType, and others all work out of the box. Your plugin picks its own validator.

```typescript
import { Plugin, toPlugin, type PluginManifest } from "@databricks/appkit";
import { z } from "zod";

const sendMessageBody = z.object({
  content: z.string().min(1),
  conversationId: z.string().optional(),
});

type SendMessageBody = z.infer<typeof sendMessageBody>;

class MyPlugin extends Plugin {
  injectRoutes(router) {
    // TypeScript infers the body type from `sendMessageBody`'s output,
    // so the explicit generic is unnecessary.
    this.route(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: sendMessageBody,
      handler: async (req, res) => {
        // req.body.content is typed as string.
        // req.body.conversationId is typed as string | undefined.
        res.json({ ok: true, content: req.body.content });
      },
    });
  }
}
```

### Behavior

- When `body` is absent, the route is a zero-overhead pass-through — your handler runs exactly as if no validation existed.
- When `body` is present, the framework calls `schema["~standard"].validate(req.body)` before invoking the handler. If validation succeeds, `req.body` is replaced with the validated value and narrowed to the schema's output type. If validation fails, the handler is not called and the framework emits a canonical 400 response.
- Validation narrows types; if you need to transform the body (e.g. coerce strings to dates), do it in the handler — transformations performed by the schema will be preserved but are not part of the v1 public contract.

### Canonical 400 error body

On validation failure the framework responds with:

```json
{
  "error": "Invalid request body",
  "code": "VALIDATION_ERROR",
  "requestId": "req_a3f9c18d",
  "issues": [
    { "path": ["content"], "message": "String must contain at least 1 character(s)" }
  ]
}
```

- `requestId` is taken from the `x-request-id` header when present, otherwise a short random token is generated. The full `issues` array is always logged server-side keyed by `requestId`, so operators can correlate client-visible 400s with detailed logs.
- `issues` is included when `NODE_ENV !== "production"`. In production the `issues` field is omitted by default to avoid leaking schema internals. Set `exposeValidationErrors: true` on the route config to opt into including `issues` in production responses.

```typescript
this.route(router, {
  name: "sendMessage",
  method: "post",
  path: "/messages",
  body: sendMessageBody,
  exposeValidationErrors: true, // include issues in prod responses
  handler: async (req, res) => { /* ... */ },
});
```

### When to opt into `exposeValidationErrors`

`exposeValidationErrors: true` surfaces the full Standard Schema `issues` array to clients in every environment, including production. That array contains field names, types, constraint messages, and any refinement text your schema carries.

**Security caveat — read before enabling.** Body validation runs BEFORE plugin-level authentication. Plugins typically authenticate inside the handler (for example with `this.asUser(req)`), but the route's `body` schema is evaluated before the handler is ever invoked. If you set `exposeValidationErrors: true` on an otherwise-protected route, **anonymous attackers in production can enumerate your schema** by submitting crafted payloads and reading the `issues` field of the resulting 400s. They can discover:

- every field name in your schema,
- the constraints on each field (`min(1)`, `max(4096)`, enum values, etc.),
- the exact message text you configured in refinements (often useful reconnaissance in its own right).

For most server-side routes the right default is to leave `exposeValidationErrors` unset. The server-side log is always populated with the full `issues` array keyed by `requestId`, so operators retain full diagnostics even when clients receive only the canonical error envelope.

Opt in only when:

- The route is intentionally public and pre-auth (for example a newsletter sign-up or a status-page feedback form), and
- Field-level feedback is valuable to end users (clients can't easily guess how to fix their payload without it), and
- The schema itself is not sensitive (no internal-only field names, no validation messages that hint at backend internals).

## Key extension points

- **Route injection**: Implement `injectRoutes()` to add custom endpoints using [`IAppRouter`](../api/appkit/TypeAlias.IAppRouter.md)
- **Lifecycle hooks**: Override `setup()`, and `shutdown()` methods
- **Shared services**:
  - **Cache management**: Access the cache service via `this.cache`. See [`CacheConfig`](../api/appkit/Interface.CacheConfig.md) for configuration.
  - **Telemetry**: Instrument your plugin with traces and metrics via `this.telemetry`. See [`ITelemetry`](../api/appkit/Interface.ITelemetry.md).
- **Execution interceptors**: Use `execute()` and `executeStream()` with [`StreamExecutionSettings`](../api/appkit/Interface.StreamExecutionSettings.md)

**Consuming your plugin programmatically**

Optionally, you may want to provide a way to consume your plugin programmatically using the AppKit object.
To do that, your plugin needs to implement the `exports` method, returning an object with the methods you want to expose. From the previous example, the plugin could be consumed as follows:

```ts
const AppKit = await createApp({
  plugins: [
    server({ port: 8000 }),
    analytics(),
    myPlugin(),
  ],
});

AppKit.myPlugin.myCustomMethod();
```

See the [`Plugin`](../api/appkit/Class.Plugin.md) API reference for complete documentation.
