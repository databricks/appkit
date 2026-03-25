# Brainstorm: Endpoint-Centric Serving Plugin with Schema-Driven Types

**Date:** 2026-03-25
**Status:** Ready for planning

## What We're Building

A **Model Serving plugin** for AppKit that provides authenticated access to Databricks Model Serving endpoints. The plugin is a **thin proxy** — handling authentication (service principal or OBO) and leveraging AppKit's interceptor chain (retry, timeout, telemetry, cache) — while exposing a generic, endpoint-centric API that works with **any** endpoint type: chat completions, embeddings, custom ML models, or agents.

The key insight: every Databricks serving endpoint exposes its own **OpenAPI schema** via `GET /api/2.0/serving-endpoints/{name}/openapi`. The schema is built from the model's MLflow signature at deploy time — each endpoint can have a different schema. Rather than hand-writing types for specific endpoint types (chat, embeddings), we **generate types from the schema** at build time. This makes the plugin generic: `invoke()` and `stream()` work with any endpoint, and the types tell you what each endpoint accepts.

### Scope

- **Generic `invoke()` / `stream()` API** — works with any serving endpoint type
- **User-defined aliases** — name your endpoints semantically (`llm`, `embedder`, `fast`, `quality`)
- **Schema-driven type generation** — TypeScript types generated from per-endpoint OpenAPI specs
- **Default mode** (zero config) + **named mode** (multiple endpoints with aliases)
- **Programmatic API** (`exports()`) for server-side use + **HTTP routes** for frontend consumption

### Out of Scope (for v1)

- Endpoint management (create/update/delete/start/stop)
- Conversation/session management
- Response normalization or custom abstractions
- High-level streaming helpers (events, `finalContent()`, etc.) — raw AsyncGenerator only

## Why This Approach

### Why endpoint-centric (not semantic methods)

A semantic API with named methods like `chat()`, `embed()`, `score()` would require the plugin to know what each endpoint does. This doesn't hold up:

1. **Endpoints are generic** — serving endpoints can serve chat models, embedding models, custom ML models, or agents. Semantic methods don't generalize across these.
2. **Types are per-endpoint, not per-operation** — a chat endpoint's schema differs from an embedding endpoint's schema. Both are just "invoke the endpoint with these params."
3. **Parameter allowlists become the source of truth** — without schema generation, the plugin must maintain a hand-written list of which parameters to forward. This is fragile and endpoint-specific.
4. **Schema generation maps naturally to endpoint-centric API** — the schema key is the endpoint (or alias), and `invoke()` / `stream()` are the only operations. Semantic methods are an unnecessary abstraction layer.

### Why schema-driven types

1. **The schema already exists** — every endpoint exposes its OpenAPI spec. Not using it means hand-writing what's already machine-readable.
2. **AppKit already has this pattern** — the query type generator fetches SQL schemas via `DESCRIBE QUERY` and generates `.d.ts` files. The serving equivalent is the same flow with a different schema source.
3. **Schema as runtime filter** — the generated schema can replace parameter allowlists at runtime. Only params in the schema get forwarded to Databricks. No hand-maintained security lists.
4. **Custom model support for free** — custom MLflow models with custom signatures get full type safety without the plugin knowing anything about them.

### Why thin proxy

1. **Interceptors provide the value** — retry, timeout, caching, and telemetry come free from the Plugin base class
2. **Less maintenance** — passthrough means less code to break when upstream APIs evolve
3. **Composability** — other plugins or app code can build higher-level abstractions on top

## API Design

### Plugin Configuration

```typescript
import { serving } from '@databricks/appkit';

// Default mode — single endpoint from env var
const app = await createApp({
  plugins: [
    serving(), // reads DATABRICKS_SERVING_ENDPOINT
  ],
});

// Named mode — multiple endpoints with aliases
const app = await createApp({
  plugins: [
    serving({
      endpoints: {
        llm: { env: "DATABRICKS_SERVING_ENDPOINT" },
        embedder: { env: "DATABRICKS_SERVING_ENDPOINT_EMBEDDING" },
      },
    }),
  ],
});

// Named mode with servedModel override (targets specific model in multi-model endpoint)
const app = await createApp({
  plugins: [
    serving({
      endpoints: {
        llm: {
          env: "DATABRICKS_SERVING_ENDPOINT",
          servedModel: "llama-v2", // bypasses traffic routing, uses this model's schema
        },
      },
    }),
  ],
});
```

### Programmatic API (exports)

```typescript
// Default mode — methods directly on appkit.serving
const response = await appkit.serving.invoke({
  messages: [{ role: "user", content: "Hello" }],
  temperature: 0.7,
});

const stream = appkit.serving.stream({
  messages: [{ role: "user", content: "Hello" }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0].delta.content ?? "");
}

// Named mode — methods on appkit.serving.{alias}
const response = await appkit.serving.llm.invoke({
  messages: [{ role: "user", content: "Hello" }],
});

const embeddings = await appkit.serving.embedder.invoke({
  input: "Search query text",
});

// OBO (on-behalf-of user)
const response = await appkit.serving.asUser(req).invoke({ messages: [...] });
const response = await appkit.serving.llm.asUser(req).invoke({ messages: [...] });
```

### HTTP Routes

**Default mode:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/serving/invoke` | Non-streaming invocation |
| `POST` | `/api/serving/stream` | Streaming invocation (SSE) |

**Named mode:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/serving/:alias/invoke` | Non-streaming invocation for named endpoint |
| `POST` | `/api/serving/:alias/stream` | Streaming invocation for named endpoint (SSE) |

In named mode, the `:alias` is validated against configured endpoint aliases. Unknown aliases return 404.

### Type Safety

Without schema generation, `invoke()` and `stream()` accept `Record<string, unknown>`:

```typescript
// Before schema-gen: generic passthrough
appkit.serving.invoke({ anything: "goes" }); // no compile-time checking
```

With schema generation, types are narrowed per-endpoint:

```typescript
// After schema-gen: fully typed from OpenAPI spec
appkit.serving.llm.invoke({
  messages: [{ role: "user", content: "Hello" }], // typed: role must be "user" | "assistant"
  temperature: 0.7, // typed: number | null
  max_tokens: 256,  // typed: integer
  // unknown_param: true  ← compile error: not in schema
});
```

## Schema-Driven Type Generation

### How It Works

```
Endpoint alias (config)
  → Resolve endpoint name (from env var)
    → GET /api/2.0/serving-endpoints/{name}/openapi
      → OpenAPI 3.1.0 JSON document
        → Convert to TypeScript interfaces
          → Write .d.ts with module augmentation
            → ServingEndpointRegistry keyed by alias
```

### Real OpenAPI Schema Example

From `databricks serving-endpoints get-open-api pkosiec` (Llama 3.1 8B Instruct):

```json
{
  "openapi": "3.1.0",
  "info": { "title": "pkosiec", "version": "1" },
  "servers": [
    { "url": "https://e2-dogfood.staging.cloud.databricks.com/serving-endpoints/pkosiec" }
  ],
  "paths": {
    "/served-models/meta_llama_v3_1_8b_instruct-4/invocations": {
      "post": {
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "messages": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "role": { "type": "string", "enum": ["user", "assistant"] },
                        "content": { "type": "string" }
                      }
                    }
                  },
                  "n": { "type": "integer", "nullable": true },
                  "max_tokens": { "type": "integer" },
                  "top_p": { "type": "number", "format": "double", "nullable": true },
                  "reasoning_effort": { "type": "string", "enum": ["low", "medium", "high"], "nullable": true },
                  "temperature": { "type": "number", "format": "double", "nullable": true },
                  "stop": { "oneOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }], "nullable": true },
                  "stream": { "type": "boolean", "nullable": true }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Successful operation",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "model": { "type": "string" },
                    "choices": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "index": { "type": "integer" },
                          "message": {
                            "type": "object",
                            "properties": {
                              "role": { "type": "string", "enum": ["user", "assistant"] },
                              "content": { "type": "string" }
                            }
                          },
                          "finish_reason": { "type": "string" }
                        }
                      }
                    },
                    "usage": {
                      "type": "object",
                      "properties": {
                        "prompt_tokens": { "type": "integer" },
                        "completion_tokens": { "type": "integer" },
                        "total_tokens": { "type": "integer" }
                      },
                      "nullable": true
                    },
                    "object": { "type": "string" },
                    "id": { "type": "string" },
                    "created": { "type": "integer" }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

### Generated TypeScript Output

From the above schema, the type generator produces the following output with three type keys per endpoint: `request`, `response`, and `chunk`.

Notes:
- **`stream`** is excluded from the generated request type — the plugin controls this via `invoke()` vs `stream()` method choice
- **`chunk`** is auto-derived from the response schema assuming OpenAI-compatible streaming format

```typescript
// Auto-generated by AppKit - DO NOT EDIT
// Generated from serving endpoint OpenAPI schemas
import "@databricks/appkit";

declare module "@databricks/appkit" {
  interface ServingEndpointRegistry {
    default: {
      request: {
        messages: Array<{
          role: "user" | "assistant";
          content: string;
        }>;
        /** @openapi integer, nullable */
        n?: number | null;
        /** @openapi integer */
        max_tokens: number;
        /** @openapi double, nullable */
        top_p?: number | null;
        reasoning_effort?: "low" | "medium" | "high" | null;
        /** @openapi double, nullable */
        temperature?: number | null;
        stop?: string | string[] | null;
      };
      response: {
        model: string;
        choices: Array<{
          index: number;
          message: {
            role: "user" | "assistant";
            content: string;
          };
          finish_reason: string;
        }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        } | null;
        object: string;
        id: string;
        created: number;
      };
      chunk: {
        id: string;
        model: string;
        choices: Array<{
          index: number;
          delta: Partial<{
            role: "user" | "assistant";
            content: string;
          }>;
          finish_reason: string | null;
        }>;
        object: string;
        created: number;
      };
    };
  }
}
```

The `chunk` type is derived by: replacing `message` with `delta: Partial<message>`, making `finish_reason` nullable, and dropping `usage` (only present in the final chunk, if at all). For custom models that don't follow OpenAI format, `chunk` is omitted and `stream()` returns `AsyncGenerator<unknown>`.

### OpenAPI → TypeScript Mapping Rules

| OpenAPI | TypeScript | Notes |
|---------|-----------|-------|
| `type: "string"` | `string` | |
| `type: "string", enum: [...]` | `"a" \| "b" \| "c"` | String literal union |
| `type: "integer"` | `number` | JS has no integer type |
| `type: "number"` | `number` | |
| `type: "boolean"` | `boolean` | |
| `type: "array", items: X` | `X[]` | Recursive |
| `type: "object", properties: {...}` | `{ ... }` | Inline interface |
| `nullable: true` | `\| null` | Appended to base type |
| `oneOf: [A, B]` | `A \| B` | Union type |
| Property not in `required` | `prop?: T` | Optional |
| `format: "double"` | `number` | Annotation only (JSDoc) |

Special handling:
- **`stream` property** is stripped from generated request types — the plugin controls this
- **Nested objects** are inlined (no `$ref` resolution needed — Databricks schemas are self-contained)
- **Unknown/missing types** fall back to `unknown`

### Comparison with Existing Query Type Generator

| Aspect | Query Type Generator | Serving Type Generator |
|--------|---------------------|----------------------|
| **Trigger** | `DATABRICKS_WAREHOUSE_ID` env var + `config/queries/` folder | `DATABRICKS_SERVING_ENDPOINT` env var (or `endpoints` config) |
| **Schema source** | `DESCRIBE QUERY <sql>` via SQL Warehouse | `GET /api/2.0/serving-endpoints/{name}/openapi` |
| **Input** | `.sql` files in watched folder | Endpoint names from env vars / config |
| **Output** | `QueryRegistry` interface in `@databricks/appkit-ui/react` | `ServingEndpointRegistry` interface in `@databricks/appkit` |
| **Cache key** | MD5 of SQL content | Hash of OpenAPI schema JSON |
| **Watch mode** | `.sql` file changes in watched folders | Env var changes (or manual trigger) |
| **Type shape** | `{ name, parameters, result }` per query | `{ request, response, chunk }` per endpoint |
| **Converter** | SQL column types → TS types | OpenAPI schema → TS types |

### Integration with Vite Plugin

The serving type generator extends the existing `appKitTypesPlugin` (or runs as a companion plugin):

```typescript
// In vite-plugin.ts — extend or add alongside existing plugin
export function appKitServingTypesPlugin(options?: {
  outFile?: string;  // default: "src/appKitServingTypes.d.ts"
}): Plugin {
  return {
    name: "appkit-serving-types",
    async buildStart() {
      // Runs at dev server start AND production build
      // Gated on DATABRICKS_SERVING_ENDPOINT being set
      if (!process.env.DATABRICKS_SERVING_ENDPOINT) return;
      await generateServingTypes({ outFile, endpoints });
    },
    // No file watcher needed — schemas change on endpoint redeploy, not on file edit
    // Cache ensures repeated builds don't re-fetch unchanged schemas
  };
}
```

Key difference from query type gen: **no file watcher needed**. Query schemas change when `.sql` files change (local edits). Serving schemas change when endpoints are redeployed (external event). A `--force` flag or TTL-based refresh handles staleness.

### Caching

Same pattern as query type gen (`cache.ts`):

```
Cache location: node_modules/.databricks/appkit/.appkit-serving-types-cache.json

{
  "version": "1",
  "endpoints": {
    "alias": {
      "hash": "sha256-of-openapi-json",
      "requestType": "{ messages: Array<...>; ... }",
      "responseType": "{ model: string; ... }",
      "chunkType": "{ id: string; ... } | null"
    }
  }
}
```

Cache hit: schema hash matches → skip fetch + conversion, use cached types.
Cache miss: fetch schema → convert → save cache → write `.d.ts`.

### Schema as Runtime Filter

Beyond compile-time types, the fetched schema can serve as a **runtime parameter filter**:

```typescript
// At build time: schema is fetched and cached
// At runtime: plugin loads cached schema and uses it to filter request bodies

const allowedParams = new Set(Object.keys(schema.requestBody.properties));

function filterRequest(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => allowedParams.has(key))
  );
}
```

The schema IS the allowlist — always up-to-date with what the endpoint actually accepts. No hand-maintained parameter lists needed.

When schema-gen hasn't run (no cached schema), the plugin falls back to passthrough with a body size limit (1MB).

## Key Decisions

1. **`invoke()` + `stream()` over `chat()` + `embed()`** — Generic methods work with any endpoint type. The schema determines what params are valid, not the method name.

2. **User-defined aliases over raw endpoint names** — Aliases are valid JS identifiers (dot notation), semantic (`llm`, `embedder`), and serve as type registry keys. Raw endpoint names have dashes and are long.

3. **Default mode with zero config** — `serving()` reads `DATABRICKS_SERVING_ENDPOINT` and exposes methods directly on `appkit.serving`. No alias needed for the common single-endpoint case.

4. **Schema generation is additive** — The plugin works without it (generic types, passthrough). Schema-gen adds type safety and runtime filtering as a build-time enhancement.

5. **Separate Vite plugin (not merged into query type gen)** — Different schema source, different output interface, different trigger conditions. Keeps both plugins simple.

6. **No file watcher for serving schemas** — Schemas change on endpoint redeploy, not on local file edit. Cache-based with manual/build-time refresh.

7. **Streaming chunks derived from response schema** — Assume OpenAI-compatible format; custom models fall back to `AsyncGenerator<unknown>`. See Resolved Question 1.

8. **First path + optional `servedModel` override** — Default to first served model's schema; `servedModel` config targets a specific model and uses its schema. See Resolved Question 2.

9. **Warn and strip unknown params** — Strip with logged warning when schema is available; passthrough when not. See Resolved Question 3.

## Open Questions

_(None — all key decisions resolved during brainstorm)_

## Resolved Questions

1. **How should streaming chunks be typed?** → **Derive from response schema, assuming OpenAI-compatible format.** The type generator transforms the response type: `message` → `delta: Partial<message>`, `finish_reason` becomes nullable. This works for all Foundation Model API endpoints (Llama, DBRX, Mixtral, etc.) which are guaranteed to follow the OpenAI `ChatCompletionChunk` format. Custom MLflow models that don't follow this pattern fall back to `AsyncGenerator<unknown>`.

2. **Multi-served-model endpoints** → **Use first path by default, with optional `servedModel` override.** Multi-model endpoints are primarily for A/B testing / canary deployments — traffic routing is server-side by percentage, and all served models typically share the same schema. The plugin calls the endpoint-level URL (`/serving-endpoints/{name}/invocations`) by default and uses the first path's schema for types. When `servedModel` is specified in config, the plugin uses that model's schema for types AND targets it directly via `/served-models/{name}/invocations`, bypassing traffic routing.

   ```typescript
   // Default: endpoint-level URL, first path's schema
   serving() // → POST /serving-endpoints/{name}/invocations

   // Override: specific served model URL + schema
   serving({
     endpoints: {
       llm: {
         env: "DATABRICKS_SERVING_ENDPOINT",
         servedModel: "llama-v2", // → types from llama-v2's schema
         // → POST /served-models/llama-v2/invocations
       },
     },
   })
   ```

3. **Should `invoke()` strip unknown params at runtime?** → **Warn and strip.** When the schema is available, unknown params are stripped from the request body and a warning is logged (e.g., `[appkit:serving] Stripped unknown param 'bad' (not in endpoint schema)`). This catches developer mistakes without breaking at runtime. When no schema is cached (schema-gen hasn't run), the plugin falls back to passthrough with a body size limit (1MB).

## References

- [Databricks Model Serving overview](https://docs.databricks.com/aws/en/machine-learning/model-serving/)
- [Serving Endpoints OpenAPI Schema API](https://docs.databricks.com/api/workspace/servingendpoints/getopenapi)
- [Query chat models](https://docs.databricks.com/aws/en/machine-learning/model-serving/query-chat-models)
- [Serve multiple models to a serving endpoint](https://docs.databricks.com/aws/en/machine-learning/model-serving/serve-multiple-models-to-serving-endpoint)
- [Databricks Apps: Model Serving integration](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/model-serving)
- Existing type generator: `packages/appkit/src/type-generator/`
- Existing plugin patterns: Analytics, Files, Genie
