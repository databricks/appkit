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

## Context helper functions

Exported from `@databricks/appkit`:

- `getCurrentUserId()`: Returns user ID in user context, service user ID otherwise
- `getWorkspaceClient()`: Returns the appropriate WorkspaceClient for current context
- `getWarehouseId()`: `Promise<string>` (from `DATABRICKS_WAREHOUSE_ID` or auto-selected in dev)
- `getWorkspaceId()`: `Promise<string>` (from `DATABRICKS_WORKSPACE_ID` or fetched)
- `isInUserContext()`: Returns `true` if currently executing in user context

## Development mode behavior

In local development (`NODE_ENV=development`), if `asUser(req)` is called without a user token, it logs a warning and falls back to the service principal.
