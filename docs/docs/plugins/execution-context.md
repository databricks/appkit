---
sidebar_position: 5
---

# Execution context

AppKit manages Databricks authentication via two contexts:

- **ServiceContext** (singleton): Initialized at app startup with service principal credentials
- **ExecutionContext**: Determined at runtime - either service principal or user context

## Headers for user context

- `x-forwarded-user`: required in production; identifies the user
- `x-forwarded-access-token`: required for user token passthrough

## Using `asUser(req)` for user-scoped operations

The `asUser(req)` pattern allows plugins to execute operations using the requesting user's credentials:

```ts
// In a custom plugin route handler
router.post("/users/me/data", async (req, res) => {
  // Execute as the user (uses their Databricks permissions)
  const result = await this.asUser(req).query("SELECT ...");
  res.json(result);
});

// Service principal execution (default)
router.post("/system/data", async (req, res) => {
  const result = await this.query("SELECT ...");
  res.json(result);
});
```

## Which built-in surfaces run OBO vs service principal

The default is the **service principal**: an operation runs on behalf of the user only when it goes through `asUser(req)`, which needs the forwarded user token. There is no global "OBO everywhere" mode, so identity is decided per surface:

| Surface | Runs as | Why |
| --- | --- | --- |
| Genie routes | signed-in user (OBO) | the built-in route calls `asUser(req)` automatically |
| Files / Analytics ops via `asUser(req)` | signed-in user (OBO) | service principal by default; OBO only when you wrap the call in `asUser(req)` |
| Agents plugin `/chat` — the model (LLM) call | app service principal | the chat route does not call `asUser`, and the model adapter is built at startup with the service-principal client |
| Agents plugin — plugin-toolkit tool calls (`plugin:<name>`) | signed-in user (OBO) | dispatched through `asUser(req)` per call |
| Agents plugin — hand-rolled `tool({ execute })` | app service principal | receives only tool arguments, no `req`, so it can't opt into OBO |
| Standalone `runAgent` (no HTTP request) | app service principal | no request context, so neither the model nor any tool runs OBO |
| Serving plugin (deprecated) routes | signed-in user (OBO) | the built-in route calls `asUser(req)`; prefer the agents plugin |

So an agent's **model inference runs as the service principal**; only the plugin tools it calls over the built-in HTTP routes run on behalf of the user. See the [agents plugin](./agents.md) for the tool-level detail.

## Context helper functions

Exported from `@databricks/appkit`:

- `getCurrentUserId()`: Returns user ID in user context, service user ID otherwise
- `getWorkspaceClient()`: Returns the appropriate WorkspaceClient for current context
- `getWarehouseId()`: `Promise<string>` (from `DATABRICKS_WAREHOUSE_ID` or auto-selected in dev)
- `getWorkspaceId()`: `Promise<string>` (from `DATABRICKS_WORKSPACE_ID` or fetched)

## Telemetry span attributes

The `plugin.execute` span created by the execution interceptor chain includes these attributes:

| Attribute | Type | Description |
|-----------|------|-------------|
| `execution.context` | `"user"` \| `"service"` | Whether the operation runs as a user (OBO) or service principal |
| `caller.id` | `string` | The user ID (OBO) or service principal ID |
| `execution.obo_dev_fallback` | `boolean` | Set to `true` when an OBO call falls back to service principal in development mode |

These attributes are automatically added when your plugin uses `execute()` or `executeStream()`. All built-in plugins use these methods for their OBO operations. Custom plugins should do the same to get automatic telemetry instrumentation.

## Lakebase per-user connections

The Lakebase plugin uses a different mechanism for `asUser(req)`: instead of swapping the `WorkspaceClient` via AsyncLocalStorage, it creates a **separate `pg.Pool` per user**, each with its own OAuth token refresh. This is necessary because PostgreSQL connections are authenticated at connection time — the pool itself is the authentication boundary.

See [Lakebase plugin — per-user connections](./lakebase.md#on-behalf-of-obo--per-user-connections) for details.

## Development mode behavior

In local development (`NODE_ENV=development`), if `asUser(req)` is called without a user token, it logs a warning and skips user impersonation — the operation runs with the default credentials configured for the app instead. The telemetry span will show `execution.context: "service"` with `execution.obo_dev_fallback: true` to distinguish these from regular service principal calls.
