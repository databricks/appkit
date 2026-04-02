---
sidebar_position: 7
---

# Serving plugin

Provides an authenticated proxy to [Databricks Model Serving](https://docs.databricks.com/aws/en/machine-learning/model-serving) endpoints, with invoke and streaming support.

**Key features:**
- Named endpoint aliases for multiple serving endpoints
- Non-streaming (`invoke`) and SSE streaming (`stream`) invocation
- Automatic OpenAPI type generation for request/response schemas
- Request body filtering based on endpoint schema
- On-behalf-of (OBO) user execution

## Basic usage

```ts
import { createApp, server, serving } from "@databricks/appkit";

await createApp({
  plugins: [
    server(),
    serving(),
  ],
});
```

With no configuration, the plugin reads `DATABRICKS_SERVING_ENDPOINT` from the environment and registers it under the `default` alias.

## Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoints` | `Record<string, EndpointConfig>` | `{ default: { env: "DATABRICKS_SERVING_ENDPOINT" } }` | Map of alias names to endpoint configs |
| `timeout` | `number` | `120000` | Request timeout in ms |

### Endpoint aliases

Endpoint aliases let you reference multiple serving endpoints by name:

```ts
serving({
  endpoints: {
    llm: { env: "DATABRICKS_SERVING_ENDPOINT" },
    classifier: { env: "DATABRICKS_SERVING_ENDPOINT_CLASSIFIER" },
  },
})
```

Each alias maps to an environment variable holding the actual endpoint name. If an endpoint serves multiple models, you can use `servedModel` to bypass traffic routing and target a specific model directly:

```ts
serving({
  endpoints: {
    llm: { env: "DATABRICKS_SERVING_ENDPOINT", servedModel: "llama-v2" },
  },
})
```

## Type generation

The `appKitServingTypesPlugin()` Vite plugin generates TypeScript types from your serving endpoints' OpenAPI schemas. Add it to your `vite.config.ts`:

```ts
import { appKitServingTypesPlugin } from "@databricks/appkit";

export default defineConfig({
  plugins: [
    appKitServingTypesPlugin(),
  ],
});
```

The plugin auto-discovers endpoint configuration from your server file (`server/index.ts` or `server/server.ts`) — no manual config passing needed.

Generated types provide:
- **Alias autocomplete** in both backend (`AppKit.serving("alias")`) and frontend hooks (`useServingStream`, `useServingInvoke`)
- **Typed request/response/chunk** per endpoint based on OpenAPI schemas

If an endpoint's OpenAPI schema is unavailable (not deployed, env var not set), the plugin generates generic fallback types. The endpoint is still usable — just without typed request/response.

## Environment variables

| Variable | Description |
|----------|-------------|
| `DATABRICKS_SERVING_ENDPOINT` | Default endpoint name (used when `endpoints` config is omitted) |

When using named endpoints, define a custom environment variable per alias (e.g. `DATABRICKS_SERVING_ENDPOINT_CLASSIFIER`).

## HTTP endpoints

### Named mode (with `endpoints` config)

- `POST /api/serving/:alias/invoke` — Non-streaming invocation
- `POST /api/serving/:alias/stream` — SSE streaming invocation

### Default mode (no `endpoints` config)

- `POST /api/serving/invoke` — Non-streaming invocation
- `POST /api/serving/stream` — SSE streaming invocation

### Request format

```
POST /api/serving/:alias/invoke
Content-Type: application/json

{
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

## Programmatic access

The plugin exports `invoke` and `stream` methods for server-side use:

```ts
const AppKit = await createApp({
  plugins: [
    server(),
    serving({
      endpoints: {
        llm: { env: "DATABRICKS_SERVING_ENDPOINT" },
      },
    }),
  ],
});

// Non-streaming
const result = await AppKit.serving("llm").invoke({
  messages: [{ role: "user", content: "Hello" }],
});

// Streaming
for await (const chunk of AppKit.serving("llm").stream({
  messages: [{ role: "user", content: "Hello" }],
})) {
  console.log(chunk);
}
```

## Frontend hooks

The `@databricks/appkit-ui` package provides React hooks for serving endpoints:

### useServingStream

Streaming invocation via SSE:

```tsx
import { useServingStream } from "@databricks/appkit-ui/react";

function ChatStream() {
  const { stream, chunks, streaming, error, reset } = useServingStream(
    { messages: [{ role: "user", content: "Hello" }] },
    { alias: "llm" },
  );

  return (
    <>
      <button onClick={stream} disabled={streaming}>Send</button>
      <button onClick={reset}>Reset</button>
      {chunks.map((chunk, i) => <pre key={i}>{JSON.stringify(chunk)}</pre>)}
      {error && <p>{error}</p>}
    </>
  );
}
```

### useServingInvoke

Non-streaming invocation:

```tsx
import { useServingInvoke } from "@databricks/appkit-ui/react";

function Classify() {
  const { invoke, data, loading, error } = useServingInvoke(
    { inputs: ["sample text"] },
    { alias: "classifier" },
  );

  return (
    <>
      <button onClick={invoke} disabled={loading}>Classify</button>
      {data && <pre>{JSON.stringify(data)}</pre>}
      {error && <p>{error}</p>}
    </>
  );
}
```

Both hooks accept `autoStart: true` to invoke automatically on mount.
