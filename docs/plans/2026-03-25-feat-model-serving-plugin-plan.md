# Plan: Implement Model Serving Plugin with Schema-Driven Type Generation

---
title: feat: Model Serving Plugin with Schema-Driven Types
type: feat
status: completed
date: 2026-03-25
origin: docs/brainstorms/2026-03-25-serving-endpoint-centric-api-brainstorm.md
---

## Context

AppKit has no model serving support. Apps needing Databricks Model Serving must handle auth, streaming, retry, and types manually. This plan implements the serving plugin designed in the brainstorm — a thin proxy with generic `invoke()` / `stream()` methods and build-time type generation from per-endpoint OpenAPI schemas.

**Origin brainstorm:** [docs/brainstorms/2026-03-25-serving-endpoint-centric-api-brainstorm.md](docs/brainstorms/2026-03-25-serving-endpoint-centric-api-brainstorm.md)

## Key Decisions (from brainstorm)

1. `invoke()` + `stream()` over `chat()` / `embed()` — generic, schema determines params
2. User-defined aliases (`llm`, `embedder`) as type registry keys
3. Default mode (zero config) + Named mode (multiple endpoints)
4. Schema generation is additive — plugin works without it
5. Separate Vite plugin from query type gen
6. No file watcher — schemas change on endpoint redeploy
7. Streaming chunks derived from response schema (OpenAI-compatible assumption)
8. First path + optional `servedModel` override for multi-model endpoints
9. Warn and strip unknown params when schema available; passthrough when not

## Design Decisions (resolved during planning)

These gaps were identified by SpecFlow analysis and resolved here:

1. **HTTP route OBO policy:** All HTTP routes use `this.asUser(req)` (same as Genie). LLM calls should run as the user for billing/permissions. In local dev without OBO headers, falls back to service principal with warning (existing behavior).

2. **Named mode exports shape:** Follow Genie's flat `exports()` pattern. Default mode returns `{ invoke, stream }`. Named mode returns `{ [alias]: { invoke, stream } }`. AppKit's `wrapWithAsUser()` (in `core/appkit.ts`) adds a top-level `asUser(req)` on the exports object. Calling it returns a new exports object where all methods — including those in nested alias objects — are recursively bound to the user-scoped plugin via `bindExportMethods()`. The correct call pattern is `appkit.serving.asUser(req).llm.invoke(...)`, NOT `appkit.serving.llm.asUser(req).invoke(...)` (alias objects have no `asUser()` method).

3. **`stream: true` injection:** The plugin injects `"stream": true` into the request body automatically when routing through `stream()` / the stream HTTP route. Stripped from generated types so developers can't pass it.

4. **Endpoint not configured:** Follow Genie pattern — initialize successfully, routes return 404 if alias not found or endpoint name empty. No hard failure at startup.

5. **Vite plugin endpoint config:** The Vite plugin accepts the same `endpoints` config as the serving plugin, passed explicitly by the developer in `vite.config.ts`. For default mode, reads `DATABRICKS_SERVING_ENDPOINT` from env.

6. **Defaults:** `timeout: 120_000`, `retry: { enabled: false }` (LLM calls not idempotent), `cache: { enabled: false }`.

7. **Programmatic `stream()` vs HTTP stream:** Programmatic `stream()` returns true `AsyncGenerator` calling Databricks directly (no SSE). HTTP `/stream` route uses `executeStream()` + `StreamManager` for SSE. Same as Genie's dual path (`sendMessage` generator + `_handleSendMessage` SSE handler).

8. **Chunk type heuristic:** OpenAI-compatible if response schema has `choices` array where items have a `message` object property. Otherwise `chunk` is omitted → `stream()` returns `AsyncGenerator<unknown>`.

9. **Connector approach:** Direct HTTP fetch using `workspaceClient.config.authenticate(headers)` + native `fetch()`. The `@databricks/sdk-experimental` (v0.16.0) provides serving endpoint management APIs but no invocation method. This matches the Files connector pattern (`connectors/files/client.ts`). Authentication is handled by `client.config.authenticate(headers)` which adds the correct OAuth/PAT headers automatically. The invocation URL is `POST /serving-endpoints/{name}/invocations` (or `/served-models/{model}/invocations` with `servedModel`).

10. **Error responses:** Map upstream Databricks errors to appropriate HTTP statuses: 400 (bad params) → 400 with upstream message, 401/403 (auth) → forward status + log warning, 404 (endpoint not found) → 404, 429 (rate limited) → 429 with `Retry-After` header forwarded, 503 (model loading/cold start) → 503, other 5xx → 502 (bad gateway). Streaming errors use SSE error events via `StreamManager` with `{ error: string, status: number }` payload.

---

## Implementation Phases

### Phase 1: Core Plugin (no type gen)

The plugin, connector, manifest, routes, OBO, and `exports()`.

#### Files to Create

**`packages/appkit/src/connectors/serving/client.ts`** — Serving connector
- `invoke(workspaceClient, endpointName, body, options?)` → `Promise<unknown>`
- `stream(workspaceClient, endpointName, body, options?)` → `AsyncGenerator<unknown>`
- Constructs authenticated HTTP requests using host/token from `workspaceClient.config`
- The connector ALWAYS strips `stream` from the incoming body before forwarding, regardless of schema filter availability
- For `invoke`: POST to `/serving-endpoints/{name}/invocations` (without `stream` in body), return parsed JSON
- For `stream`: POST with `"stream": true` injected into body, parse response as NDJSON (newline-delimited `data: {...}` SSE lines), yield each parsed chunk
- `servedModel` option switches URL to `/served-models/{model}/invocations`
- Accepts `AbortSignal` for cancellation
- Use `client.config.authenticate(headers)` for auth (same as Files connector at `connectors/files/client.ts:280`)
- Use native `fetch()` (not axios or node-fetch)
- No plugin-level body size limit — Express body parser config controls this at the app level
- Map upstream error statuses per Design Decision 10 (400, 401/403, 404, 429 with Retry-After, 503, 5xx → 502)

**`packages/appkit/src/connectors/serving/types.ts`** — Connector types
- `ServingConnectorConfig` (timeout)
- `ServingInvokeOptions` (servedModel?, signal?)

**`packages/appkit/src/connectors/serving/defaults.ts`** — Connector defaults

**`packages/appkit/src/connectors/serving/index.ts`** — Barrel export

**`packages/appkit/src/plugins/serving/types.ts`** — Plugin types
- `EndpointConfig { env: string; servedModel?: string }`
- `IServingConfig extends BasePluginConfig { endpoints?: Record<string, EndpointConfig> }`
- `ServingEndpointRegistry {}` (empty base, augmented by type gen)

**`packages/appkit/src/plugins/serving/manifest.json`** — Plugin manifest
- Include `"$schema": "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json"` (same as Files plugin at `plugins/files/manifest.json`)
- Resource type: `ResourceType.SERVING_ENDPOINT` (`"serving_endpoint"`, confirmed in `registry/types.generated.ts`). Permission: `CAN_QUERY` (from `ServingEndpointPermission`)
- Optional in static manifest; `getResourceRequirements(config)` makes entries required at runtime

**`packages/appkit/src/plugins/serving/defaults.ts`** — Execution defaults
- `invokeDefaults`: timeout 120s, retry disabled, cache disabled
- `streamDefaults`: timeout 120s, retry disabled, cache disabled, bufferSize 200

**`packages/appkit/src/plugins/serving/serving.ts`** — Main plugin class
- Extends `Plugin`, static `manifest` as `PluginManifest<"serving">`
- `static getResourceRequirements(config)` — generates one `serving_endpoint` requirement per configured alias (follows Files plugin pattern at `packages/appkit/src/plugins/files/plugin.ts:76`)
- Constructor: if `config.endpoints` present → named mode; else → default mode reads `DATABRICKS_SERVING_ENDPOINT`
- `injectRoutes()`:
  - Default mode: `POST /invoke`, `POST /stream`
  - Named mode: `POST /:alias/invoke`, `POST /:alias/stream`
  - All routes call `this.asUser(req)._handle*()` (Genie pattern at `genie.ts:56`)
- `_handleInvoke(req, res)`: resolve alias → endpoint name, call connector.invoke via `this.execute()`, return JSON
- `_handleStream(req, res)`: resolve alias → endpoint name, call connector.stream via `this.executeStream()` (Genie pattern at `genie.ts:115`)
- Programmatic `invoke(alias, body)`: calls connector directly with `this.execute()` wrapper
- Programmatic `async *stream(alias, body)`: yields from connector.stream (Genie pattern at `genie.ts:203`)
- `exports()`:
  - Default mode: `{ invoke: (body) => this.invoke("default", body), stream: (body) => this.stream("default", body) }`
  - Named mode: `{ [alias]: { invoke: (body) => ..., stream: (body) => ... } }` for each configured alias
- `shutdown()`: `this.streamManager.abortAll()`

**`packages/appkit/src/plugins/serving/index.ts`** — Barrel export + `toPlugin(ServingPlugin)`

#### Files to Modify

- `packages/appkit/src/plugins/index.ts` — add `export * from "./serving"`
- `packages/appkit/src/connectors/index.ts` — add `export * from "./serving"`
- `packages/appkit/src/index.ts` — add `serving` to exports, add `ServingEndpointRegistry` interface

#### Tests

**`packages/appkit/src/plugins/serving/tests/serving.test.ts`**
- `serving()` factory creates plugin with name "serving"
- Default mode: reads `DATABRICKS_SERVING_ENDPOINT`, registers `/invoke` + `/stream` routes
- Named mode: registers `/:alias/invoke` + `/:alias/stream`, validates alias, 404 for unknown
- Route handlers call connector with correct endpoint name
- OBO: routes call `this.asUser(req)._handle*`

**`packages/appkit/src/connectors/serving/tests/client.test.ts`**
- `invoke`: correct URL construction (default vs servedModel)
- `stream`: yields parsed NDJSON chunks, injects `"stream": true`
- AbortSignal cancellation

#### Verification
```bash
pnpm test --filter=@databricks/appkit
pnpm build
# Manual: add serving() to dev-playground, curl POST /api/serving/invoke
```

---

### Phase 2: Type Generator

OpenAPI schema fetcher, converter, cache, Vite plugin, CLI command.

#### Files to Create

**`packages/appkit/src/type-generator/serving/fetcher.ts`** — Schema fetcher
- `fetchOpenApiSchema(workspaceClient, endpointName, servedModel?)` → OpenAPI JSON or null
- `GET /api/2.0/serving-endpoints/{name}/openapi`
- If `servedModel`: find matching path in `spec.paths`; else: use first path
- Handle 404 (endpoint not found), 403 (access denied) → return null with warning
- 5s timeout for type-gen (fail fast)

**`packages/appkit/src/type-generator/serving/converter.ts`** — OpenAPI → TypeScript
- `convertRequestSchema(pathSchema)` → TypeScript type string
  - Strip `stream` property from request
  - Apply mapping rules from brainstorm (string, enum, integer, number, boolean, array, object, nullable, oneOf, optional)
  - Inline nested objects (no `$ref` resolution — Databricks schemas are self-contained)
  - Unknown types → `unknown`
- `convertResponseSchema(pathSchema)` → TypeScript type string
- `deriveChunkType(responseSchema)` → TypeScript type string | null
  - Check: `choices` array with items containing `message` object → OpenAI-compatible
  - Transform: `message` → `delta: Partial<message>`, `finish_reason` → nullable, drop `usage`
  - Return null if not OpenAI-compatible (custom model fallback)

**`packages/appkit/src/type-generator/serving/cache.ts`** — Schema cache
- Same pattern as `packages/appkit/src/type-generator/cache.ts`
- Cache file: `node_modules/.databricks/appkit/.appkit-serving-types-cache.json`
- Cache shape: `{ version: "1", endpoints: { [alias]: { hash, requestType, responseType, chunkType } } }`
- Hash: SHA256 of raw OpenAPI JSON string
- Functions: `loadServingCache()`, `saveServingCache()`, `hashSchema()`

**`packages/appkit/src/type-generator/serving/generator.ts`** — Main generation
- `generateServingTypes(options: { outFile, endpoints, noCache })` → void
- Resolve endpoint names from env vars
- For each alias: fetch schema → hash → check cache → convert if miss → save
- Generate `.d.ts` output:
  ```typescript
  // Auto-generated by AppKit - DO NOT EDIT
  import "@databricks/appkit";
  declare module "@databricks/appkit" {
    interface ServingEndpointRegistry {
      [alias]: { request: {...}; response: {...}; chunk: {...} };
    }
  }
  ```
- Write to `outFile` (default: `src/appKitServingTypes.d.ts`)

**`packages/appkit/src/type-generator/serving/vite-plugin.ts`** — Vite plugin
- `appKitServingTypesPlugin(options?: { outFile?, endpoints? })` → `Plugin`
- `apply()`: return false if no `DATABRICKS_SERVING_ENDPOINT` and no endpoints config
- `configResolved()`: compute paths
- `buildStart()`: call `generateServingTypes()`. Throw in production, warn in dev.
- No `configureServer()` watcher (schemas change on endpoint redeploy, not file edit)

**`packages/appkit/src/type-generator/serving/index.ts`** — Barrel export

#### Files to Modify

- `packages/appkit/src/index.ts` — export `appKitServingTypesPlugin` and `ServingEndpointRegistry`

#### Tests

**`packages/appkit/src/type-generator/serving/tests/converter.test.ts`**
- Each OpenAPI → TypeScript mapping rule
- `stream` property stripped from request type
- Chunk derivation for OpenAI-compatible schemas
- `null` chunk for non-OpenAI schemas
- `nullable`, `oneOf`, `enum` handling
- Nested objects inlined

**`packages/appkit/src/type-generator/serving/tests/cache.test.ts`**
- Cache miss → writes new entry
- Cache hit → uses cached type (no re-fetch)
- Version mismatch → flushes cache

**`packages/appkit/src/type-generator/serving/tests/generator.test.ts`**
- End-to-end: mock OpenAPI response → generated `.d.ts` content matches expected output

#### Verification
```bash
pnpm test --filter=@databricks/appkit
# With real endpoint:
DATABRICKS_SERVING_ENDPOINT=pkosiec pnpm dev
# Check generated src/appKitServingTypes.d.ts
```

---

### Phase 3: Runtime Schema Filter

Load cached schema at runtime to filter request bodies.

#### Files to Create

**`packages/appkit/src/plugins/serving/schema-filter.ts`** — Runtime filter
- `loadEndpointSchemas(cacheFile)` → `Map<string, Set<string>>` (alias → allowed param keys)
- `filterRequestBody(body, allowedKeys, alias)` → filtered body + log warnings for stripped params
- Warning format: `[appkit:serving] Stripped unknown params from '{alias}': {keys}` (single log per request, not per param)

#### Files to Modify

**`packages/appkit/src/plugins/serving/serving.ts`** — Integrate filter
- In `setup()`: load cached schemas into `private schemaAllowlists: Map<string, Set<string>>`
- In `_handleInvoke` / `_handleStream` and programmatic `invoke` / `stream`: if allowlist exists for alias, filter body before forwarding; else passthrough

#### Tests

**`packages/appkit/src/plugins/serving/tests/schema-filter.test.ts`**
- Filter strips unknown keys, preserves known keys
- Warning logged with stripped key names
- Returns body unchanged when no schema

#### Verification
```bash
pnpm test --filter=@databricks/appkit
# Manual: invoke with extra params, check warning logs
```

---

### Phase 4: Frontend Hooks

React hooks for consuming serving endpoints from the frontend.

#### Files to Create

**`packages/appkit-ui/src/react/hooks/use-serving-invoke.ts`** — Non-streaming hook with registry-driven type inference
```typescript
// Registry-driven type inference (same pattern as useAnalyticsQuery)
export function useServingInvoke<
  K extends keyof ServingEndpointRegistry = "default",
>(
  body: ServingEndpointRegistry[K]["request"],
  options?: { alias?: K },
): {
  invoke: () => void;
  data: ServingEndpointRegistry[K]["response"] | null;
  loading: boolean;
  error: Error | null;
}
```
- Uses `fetch` POST to `/api/serving/invoke` (default) or `/api/serving/{alias}/invoke` (named)
- Manages `AbortController` for cleanup on unmount
- Without schema-gen, `K` defaults to `"default"` and types fall back to `unknown`

**`packages/appkit-ui/src/react/hooks/use-serving-stream.ts`** — Streaming hook with registry-driven type inference
```typescript
export function useServingStream<
  K extends keyof ServingEndpointRegistry = "default",
>(
  body: ServingEndpointRegistry[K]["request"],
  options?: { alias?: K },
): {
  stream: () => void;
  chunks: ServingEndpointRegistry[K]["chunk"][];
  streaming: boolean;
  error: Error | null;
  reset: () => void;
}
```
- Uses `connectSSE` with POST payload (same pattern as `useGenieChat` at `appkit-ui/src/react/genie/use-genie-chat.ts:292`) to POST to `/api/serving/stream` or `/api/serving/{alias}/stream`
- Accumulates chunks in state array
- `reset()` clears chunks and aborts connection

#### Files to Modify

- `packages/appkit-ui/src/react/hooks/index.ts` — export new hooks
- `packages/appkit-ui/src/react/index.ts` — re-export if needed

#### Tests

**`packages/appkit-ui/src/react/hooks/__tests__/use-serving-invoke.test.ts`**
**`packages/appkit-ui/src/react/hooks/__tests__/use-serving-stream.test.ts`**
- Fetch/SSE to correct URLs, state transitions, cleanup on unmount

#### Verification
```bash
pnpm test --filter=@databricks/appkit-ui
```

---

### Phase 5: Dev Playground Integration

Wire everything up in the reference app.

#### Files to Modify

**`apps/dev-playground/server/index.ts`** — Add `serving()` to plugins

**`apps/dev-playground/client/vite.config.ts`** — Add `appKitServingTypesPlugin()`

**`apps/dev-playground/server/.env.example`** (or README) — Document `DATABRICKS_SERVING_ENDPOINT`

#### Files to Create

**`apps/dev-playground/client/src/routes/serving.route.tsx`** — Demo page
- Chat-style input form
- Toggle between invoke (full response) and stream (chunked)
- Uses `useServingInvoke` and `useServingStream` hooks

#### Files to Modify

**`apps/dev-playground/client/src/routes/__root.tsx`** — Add nav link to serving route

#### Verification
```bash
DATABRICKS_SERVING_ENDPOINT=pkosiec pnpm dev
# Open playground → Serving page → send a message → verify streaming
```

---

### Phase 6: Template + `databricks apps init` Integration

Add serving as a selectable plugin in the `databricks apps init` template and generate a standalone `appkit-serving` template variant.

#### Files to Modify

**`template/appkit.plugins.json`** — Add serving plugin entry:
```json
{
  "serving": {
    "name": "serving",
    "displayName": "Model Serving Plugin",
    "description": "Authenticated proxy to Databricks Model Serving endpoints",
    "package": "@databricks/appkit",
    "resources": {
      "required": [
        {
          "type": "serving_endpoint",
          "alias": "Serving Endpoint",
          "resourceKey": "serving-endpoint",
          "description": "Model Serving endpoint for inference",
          "permission": "CAN_QUERY",
          "fields": {
            "name": {
              "env": "DATABRICKS_SERVING_ENDPOINT",
              "description": "Serving endpoint name"
            }
          }
        }
      ],
      "optional": []
    }
  }
}
```
- NOT `requiredByTemplate` (optional, like analytics/files/genie)

**`template/server/server.ts`** — Add serving to Go template conditionals
- The existing Go template loop (`{{range $name, $_ := .plugins}}`) auto-includes any selected plugin in the import and `createApp({ plugins: [...] })` — so no manual change needed beyond what the template engine handles from `appkit.plugins.json`

**`template/client/src/App.tsx`** — Add serving page conditional
- Add `{{- if .plugins.serving}}` import for `ServingPage`
- Add nav link and route entry (same pattern as analytics/genie/files)

**`template/client/src/pages/serving/ServingPage.tsx`** — New serving demo page
- Simple chat interface using `useServingStream` hook
- Message input, streaming response display
- Wrapped in `{{if .plugins.serving}}` Go template conditional

**`template/databricks.yml.tmpl`** — Add serving user_api_scope if needed
- Check if serving endpoints need a `user_api_scopes` entry for OBO
- Add `{{- if .plugins.serving}}` conditional alongside genie/files if needed

**`template/.env.tmpl`** / **`template/.env.example.tmpl`** — No change needed
- The template engine auto-generates env vars from `appkit.plugins.json` resource fields

**`template/README.md`** — Add serving section in Go template conditionals

**`tools/generate-app-templates.ts`** — Add serving template variants
- Add to `FEATURE_DEPENDENCIES`:
  ```typescript
  serving: "Serving Endpoint",
  ```
- Add `"appkit-serving"` to `APP_TEMPLATES[]`:
  ```typescript
  {
    name: "appkit-serving",
    features: ["serving"],
    set: { "serving.serving-endpoint.name": "placeholder" },
    description: "Node.js app with Databricks Model Serving endpoint integration",
  }
  ```
- Update `"appkit-all-in-one"`:
  ```typescript
  features: ["analytics", "files", "genie", "lakebase", "serving"],
  set: { ..., "serving.serving-endpoint.name": "placeholder" },
  ```

#### Verification
```bash
# Test template rendering with serving feature
databricks apps init --template ./template --name test-serving --features serving \
  --set serving.serving-endpoint.name=placeholder --output-dir /tmp/test-templates

# Verify generated files:
# - server.ts imports and registers serving()
# - App.tsx has serving nav/route
# - .env has DATABRICKS_SERVING_ENDPOINT
# - databricks.yml has serving resource

# Generate all template variants
tsx tools/generate-app-templates.ts

# No CLI changes needed at /Users/pawel.kosiec/repositories/databricks-os/cli/cmd/apps
# The CLI reads appkit.plugins.json dynamically — adding the serving entry is sufficient
```

---

## Phase Dependencies

```
Phase 1 ──→ Phase 3 (extends serving.ts)
Phase 1 ──→ Phase 4 (HTTP routes must exist)
Phase 1 ──→ Phase 5 (plugin to register)
Phase 2 ──→ Phase 3 (reads cache from Phase 2)
Phase 2 ──→ Phase 4 (type registry for generics)
Phase 2 ──→ Phase 5 (Vite plugin)
Phase 1 + Phase 4 ──→ Phase 6 (template needs plugin + hooks to exist)
```

Phase 2's `converter.ts` and `cache.ts` are pure functions — can be developed in parallel with Phase 1.
Phase 6 can start after Phase 1 (plugin exists) but the serving page template needs Phase 4 hooks.

## Critical Reference Files

| Pattern | File | What to reuse |
|---------|------|---------------|
| Streaming plugin | `packages/appkit/src/plugins/genie/genie.ts` | `executeStream`, alias routing, `asUser(req)._handle*`, `exports()`, `async *` generators |
| Dynamic resources | `packages/appkit/src/plugins/files/plugin.ts:76` | `getResourceRequirements(config)` pattern |
| Type gen pipeline | `packages/appkit/src/type-generator/` | Vite plugin lifecycle, cache structure, `generateFromEntryPoint` pattern |
| SSE client | `packages/appkit-ui/src/js/sse/connect-sse.ts` | Frontend streaming consumption |
| Plugin base | `packages/appkit/src/plugin/plugin.ts` | `execute()`, `executeStream()`, `asUser()`, interceptor chain |

## Acceptance Criteria

- [x] `serving()` works with zero config (reads `DATABRICKS_SERVING_ENDPOINT`)
- [x] `serving({ endpoints: {...} })` supports multiple named endpoints
- [x] `appkit.serving.invoke()` and `appkit.serving.stream()` work programmatically
- [x] HTTP routes: `POST /api/serving/invoke`, `POST /api/serving/stream` (+ `/:alias/` variants)
- [x] OBO: `this.asUser(req)` on all HTTP routes
- [x] Vite plugin generates `.d.ts` with `ServingEndpointRegistry` from OpenAPI schemas
- [x] Generated types include `request`, `response`, and `chunk` (when OpenAI-compatible)
- [x] Runtime schema filter warns and strips unknown params
- [x] Frontend hooks: `useServingInvoke()` and `useServingStream()`
- [x] Dev playground demo page working with real endpoint
- [x] Template: `appkit.plugins.json` includes serving plugin entry
- [x] Template: `databricks apps init --features serving` generates a working app
- [x] Template: `tools/generate-app-templates.ts` produces `appkit-serving` and updated `appkit-all-in-one`
- [x] No changes needed in Databricks CLI (`/Users/pawel.kosiec/repositories/databricks-os/cli/cmd/apps`)
- [x] All tests passing: `pnpm test`
- [x] Build passing: `pnpm build && pnpm typecheck`

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-25-serving-endpoint-centric-api-brainstorm.md](docs/brainstorms/2026-03-25-serving-endpoint-centric-api-brainstorm.md) — key decisions: endpoint-centric API, schema-driven types, thin proxy, alias-based routing
- [Databricks Serving Endpoints OpenAPI Schema API](https://docs.databricks.com/api/workspace/servingendpoints/getopenapi)
- [Serve multiple models](https://docs.databricks.com/aws/en/machine-learning/model-serving/serve-multiple-models-to-serving-endpoint)
