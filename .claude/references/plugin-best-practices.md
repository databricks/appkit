# Plugin Best Practices

Reference guide for building AppKit plugins. Every guideline is prefixed with a severity tier:

- **NEVER** — Security or breakage blocker. Violating this will cause data leaks, crashes, or silent corruption.
- **MUST** — Correctness requirement. Violating this produces bugs, broken APIs, or inconsistent behavior.
- **SHOULD** — Quality recommendation. Violating this degrades DX, performance, or maintainability.

> **Scope:** These guidelines target **core plugins within the AppKit monorepo** (`packages/appkit/src/plugins/`). Custom plugins built outside the monorepo have more flexibility — see `docs/docs/plugins/custom-plugins.md` for lighter-weight patterns (inline manifests, camelCase names, etc.).

---

## 1. Manifest Design

**MUST** include all four required top-level fields: `name`, `displayName`, `description`, `resources`.

**MUST** use lowercase kebab-case for `name` (pattern: `^[a-z][a-z0-9-]*$`). This becomes the route prefix (`/api/{name}`) and the key on the AppKit instance. (This is a monorepo convention; custom plugins may use camelCase per the official docs.)

**MUST** declare both `resources.required` and `resources.optional` arrays, even if empty.

**MUST** give every resource a unique `resourceKey` (lowercase kebab-case). The `alias` is for display only; `resourceKey` drives deduplication, env naming, and bundle config.

**MUST** use the correct permission enum per resource type (e.g. `CAN_USE` for `sql_warehouse`, `WRITE_VOLUME` for `volume`). The schema validates this with `allOf`/`if-then` rules.

**SHOULD** add `fields` with `env` entries so that `appkit plugin sync` and `appkit init` can auto-generate `.env` templates and `app.yaml` resource blocks.

**SHOULD** set `hidden: true` on infrastructure plugins (like `server`) that should not appear in the template manifest.

**MUST** use `getResourceRequirements(config)` for resources that depend on runtime config. Two variants:

- **Config-gated flip** — when a resource is only needed if a config flag is set: declare it as `optional` in the manifest (so CLI and docs can see it) and return it with `required: true` from the static method when the flag is on. See the "Config-dependent resources" example in `docs/docs/plugins/custom-plugins.md`.
- **Dynamic discovery** — when concrete resources can't be enumerated statically (one per env var, one per config entry, etc.): keep a single required placeholder in the manifest so `apps init` can prompt for at least one, and emit the full dynamic set from `getResourceRequirements`. See `FilesPlugin` and `ServingPlugin`.

---

## 2. Plugin Class Structure

**MUST** extend `Plugin` (the base class accepts an optional generic but core plugins use the plain form).

**MUST** declare a static `manifest` property. Core plugins import `manifest.json` as a JSON module, which requires `as` (JSON imports cannot use `satisfies`):

```ts
static manifest = manifest as PluginManifest<"my-plugin">;
```

> **Note:** The `<"my-plugin">` generic is a **SHOULD** (see Section 9: Type Safety). Inline manifests — as shown in the custom-plugins docs — should use `satisfies PluginManifest<"name">` instead, which is stricter and catches structural errors at compile time.

**MUST** export a `toPlugin`-wrapped factory as the public API. Mark the factory (not the class) as `@internal`:

```ts
export class MyPlugin extends Plugin { ... }

/** @internal */
export const myPlugin = toPlugin(MyPlugin);
```

**MUST** re-declare config with `protected declare config: IMyConfig` if extending the base config type. Call `super(config)` first, then assign `this.config = config`.

**SHOULD** keep the barrel `index.ts` minimal: re-export the plugin factory and types only.

**SHOULD** use `static phase: PluginPhase` only when initialization order matters. Use `"core"` for config-only plugins, `"deferred"` for server (starts last). Default is `"normal"`.

**MUST** implement `shutdown()` and call `this.streamManager.abortAll()` if the plugin uses streaming or long-lived connections.

---

## 3. Route Design

**MUST** register routes via `this.route(router, config)` inside `injectRoutes()`. This auto-registers endpoints under `/api/{pluginName}{path}` and tracks them for the client config endpoint map.

**MUST** include a `name` in every route config. This becomes the key in `getEndpoints()` and is used by the frontend to discover URLs.

**NEVER** register routes directly on `router.get(...)` without going through `this.route()` — the endpoint will be invisible to the server plugin's endpoint map and client config.

**MUST** set `skipBodyParsing: true` on routes that receive raw streams (e.g. file uploads). The server plugin uses this to bypass `express.json()` for those paths.

**SHOULD** use RESTful conventions: `GET` for reads, `POST` for mutations and queries with bodies, `DELETE` for deletions.

**SHOULD** validate required params early and return `400` before doing any work.

---

## 4. Interceptor Usage

**SHOULD** define execution defaults in a separate `defaults.ts` file as `PluginExecuteConfig` constants. This keeps route handlers clean and makes defaults testable. (Required when the plugin uses `execute()` or `executeStream()` with non-trivial settings; not needed for plugins that don't use execution interceptors.)

**MUST** pass defaults via the `default` key in `PluginExecutionSettings`. User overrides go in `user`. The merge order is: method defaults <- plugin config <- user override.

**NEVER** enable cache without providing a `cacheKey` array. The cache interceptor silently skips caching when `cacheKey` is empty/missing, so you get no caching and no error.

**MUST** scope cache keys to include the plugin name, operation, and all varying parameters:

```ts
cache: {
  cacheKey: ["analytics:query", queryKey, JSON.stringify(params), executorKey],
}
```

**SHOULD** disable retry for non-idempotent operations (mutations, chat messages, stream creation). See `genieStreamDefaults` for the pattern.

**SHOULD** disable cache for write operations and streaming downloads. See `FILES_WRITE_DEFAULTS` and `FILES_DOWNLOAD_DEFAULTS`.

**SHOULD** set appropriate timeouts: short for reads (5-30s), long for writes/uploads (600s), very long for streaming conversations (120s+).

---

## 5. asUser / OBO Patterns

**MUST** call `this.asUser(req)` to execute operations with user credentials. The returned proxy wraps every method call in `runInUserContext(userContext, ...)`.

**NEVER** call `asUser()` on lifecycle methods (`setup`, `shutdown`, `injectRoutes`). These are excluded from the proxy via `EXCLUDED_FROM_PROXY`.

**MUST** use `.obo.sql` file suffix for analytics queries that should execute as the user. The `_handleQueryRoute` method checks `isAsUser` and conditionally wraps with `this.asUser(req)`.

**SHOULD** use `isInUserContext()` in the programmatic API to detect whether the call is running in a user context. Two patterns exist:

- **File-naming convention** (analytics): Use `.obo.sql` suffix to determine whether a query runs as user or service principal. No runtime `isInUserContext()` check needed in route handlers.
- **Runtime enforcement** (files programmatic API): Call `isInUserContext()` to warn or throw:

```ts
// Warn pattern (read operations in route handlers):
if (!isInUserContext()) { logger.warn("..."); }

// Enforce pattern (programmatic API, e.g. createVolumeAPI):
if (!isInUserContext()) { throw new Error("...use OBO..."); }
```

**MUST** scope cache keys differently for OBO vs service principal. Use `getCurrentUserId()` for OBO and `"global"` for service principal to avoid cross-user cache pollution.

**SHOULD** prefer strict enforcement (`throwIfNoUserContext`) for write operations. Use warn-only (`warnIfNoUserContext`) for read operations where service principal fallback is acceptable.

---

## 6. Client Config

**MUST** return only JSON-serializable plain data from `clientConfig()`. No functions, Dates, classes, Maps, Sets, BigInts, or circular references.

**NEVER** expose secrets, tokens, or internal URLs in `clientConfig()`. The server plugin runs `sanitizeClientConfig()` which redacts values matching non-public env vars, but defense in depth means not returning them at all.

**SHOULD** return an empty object `{}` (the default) if the plugin has no client-facing config. Only override `clientConfig()` when the frontend needs server-side values at boot time.

**SHOULD** keep client config minimal: feature flags, resource IDs, available volume keys. Avoid large payloads.

---

## 7. SSE Streaming

**MUST** use `this.executeStream(res, handler, settings)` for SSE responses. This wires up the interceptor chain, stream management, abort signals, and reconnection support.

**MUST** return an `AsyncGenerator` from the stream handler for chunked event delivery. Non-generator return values are auto-wrapped in a single yield.

**SHOULD** pass a stable `streamId` (e.g. from `requestId` query param or `randomUUID()`) in `stream.streamId` to support client reconnection via `Last-Event-ID`.

**SHOULD** configure `stream.bufferSize` for event replay on reconnection. Default is fine for most cases; increase for high-throughput streams.

**MUST** call `this.streamManager.abortAll()` in `shutdown()` to cancel all active streams during graceful shutdown.

---

## 8. Testing Expectations

**MUST** co-locate tests in a `tests/` directory inside the plugin folder (e.g. `plugins/analytics/tests/analytics.test.ts`).

**MUST** mock external connectors and the Databricks SDK. Use `vi.mock()` for connector classes. Never make real API calls in unit tests.

**SHOULD** write both unit tests (`.test.ts`) and integration tests (`.integration.test.ts`). Integration tests exercise the full interceptor chain with mocked connectors.

**SHOULD** test error paths: missing params (400), not-found (404), upstream failures (500), auth errors (401).

**SHOULD** test cache key scoping: verify that different users, different params, and different query keys produce distinct cache entries.

**SHOULD** test `asUser` proxy behavior: verify that route handlers correctly delegate to `this.asUser(req)` for OBO endpoints.

---

## 9. Type Safety

**MUST** type the config interface extending `BasePluginConfig` and export it from `types.ts`.

**MUST** type `exports()` with an explicit return type or interface when the public API is non-trivial. This ensures the registry type generation produces accurate types.

**MUST** type route handler request/response bodies. Use `req.body as IMyRequest` with a defined interface, not `any`.

**SHOULD** use `PluginManifest<"name">` generic to tie the manifest type to the plugin name literal. This enables type-safe access on the AppKit instance.

**SHOULD** use `protected declare config: IMyConfig` instead of redefining the property. The `declare` keyword preserves the base class field while narrowing the type.

**NEVER** use `any` for connector responses or SDK return types without documenting why. Prefer `unknown` and narrow with type guards, or define response interfaces.
