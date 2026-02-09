---
title: "fix: Make warehouseId optional in ServiceContext when no plugin requires it"
type: fix
date: 2026-02-09
---

# fix: Make warehouseId optional in ServiceContext when no plugin requires it

## Overview

`ServiceContext.createContext()` unconditionally calls `getWarehouseId(client)`, which in production throws if `DATABRICKS_WAREHOUSE_ID` is unset, and in dev mode fires an unnecessary API call. Only `AnalyticsPlugin` uses the warehouse ID. Apps using only `server()` should not require it.

## Problem Statement

```
createApp({ plugins: [server()] })
  -> ServiceContext.initialize()
    -> createContext()
      -> getWarehouseId(client)  // always called, throws in prod if env var missing
```

## Proposed Solution

Add `static requires` to the Plugin class so plugins declare which shared resources they need. At `createApp()` time, collect requirements from all plugins. Pass them to `ServiceContext.initialize()`. Only call `getWarehouseId()` if a plugin declared it. Make `warehouseId` optional on the interfaces.

### Changes

#### 1. Add `ServiceContextResource` type and `requires` to `PluginConstructor` (`packages/shared/src/plugin.ts`)

```typescript
export type ServiceContextResource = "warehouseId" | "workspaceId";

export type PluginConstructor<
  C = BasePluginConfig,
  I extends BasePlugin = BasePlugin,
> = (new (config: C) => I) & {
  DEFAULT_CONFIG?: Record<string, unknown>;
  phase?: PluginPhase;
  requires?: ServiceContextResource[];  // NEW
};
```

#### 2. Add default `requires` to `Plugin` base class (`packages/appkit/src/plugin/plugin.ts`)

```typescript
static requires: ServiceContextResource[] = [];
```

#### 3. Set `requires` on `AnalyticsPlugin` (`packages/appkit/src/plugins/analytics/analytics.ts`)

```typescript
export class AnalyticsPlugin extends Plugin {
  static requires: ServiceContextResource[] = ["warehouseId"];
  // ...
}
```

#### 4. Update `ServiceContext` (`packages/appkit/src/context/service-context.ts`)

Make `warehouseId` optional. Only resolve when required.

```typescript
export interface ServiceContextState {
  client: WorkspaceClient;
  serviceUserId: string;
  warehouseId?: Promise<string>;   // optional now
  workspaceId: Promise<string>;
}

static async initialize(
  requiredResources: ServiceContextResource[] = []
): Promise<ServiceContextState> {
  if (ServiceContext.instance) return ServiceContext.instance;
  if (ServiceContext.initPromise) return ServiceContext.initPromise;

  ServiceContext.initPromise = ServiceContext.createContext(requiredResources);
  ServiceContext.instance = await ServiceContext.initPromise;
  return ServiceContext.instance;
}

private static async createContext(
  requiredResources: ServiceContextResource[] = []
): Promise<ServiceContextState> {
  const client = new WorkspaceClient({}, getClientOptions());

  // Only resolve warehouseId if a plugin requires it
  const warehouseId = requiredResources.includes("warehouseId")
    ? ServiceContext.getWarehouseId(client)
    : undefined;

  const workspaceId = ServiceContext.getWorkspaceId(client);
  const currentUser = await client.currentUser.me();

  if (!currentUser.id) {
    throw ConfigurationError.resourceNotFound("Service user ID");
  }

  return { client, serviceUserId: currentUser.id, warehouseId, workspaceId };
}
```

#### 5. Update `UserContext` interface (`packages/appkit/src/context/user-context.ts`)

```typescript
export interface UserContext {
  client: ServiceContextState["client"];
  userId: string;
  userName?: string;
  warehouseId?: Promise<string>;  // optional now
  workspaceId: Promise<string>;
  isUserContext: true;
}
```

#### 6. Update `getWarehouseId()` helper (`packages/appkit/src/context/execution-context.ts`)

Since `warehouseId` is now optional on the interface, use non-null assertion — startup validation already guarantees it exists when a plugin declared `requires = ["warehouseId"]`.

```typescript
export function getWarehouseId(): Promise<string> {
  // Safe: if a plugin requires warehouseId, ServiceContext.initialize() resolved it
  return getExecutionContext().warehouseId!;
}
```

#### 7. Update `_createApp()` to collect and pass requirements (`packages/appkit/src/core/appkit.ts`)

```typescript
static async _createApp<...>(config = {}): Promise<PluginMap<T>> {
  TelemetryManager.initialize(config?.telemetry);
  await CacheManager.getInstance(config?.cache);

  const rawPlugins = config.plugins as T;
  const requiredResources = AppKit.collectRequiredResources(rawPlugins);

  await ServiceContext.initialize(requiredResources);

  const preparedPlugins = AppKit.preparePlugins(rawPlugins);
  // ...rest unchanged...
}

private static collectRequiredResources(
  plugins: PluginData<PluginConstructor, unknown, string>[]
): ServiceContextResource[] {
  const resources = new Set<ServiceContextResource>();
  for (const { plugin } of plugins) {
    for (const req of plugin.requires ?? []) {
      resources.add(req);
    }
  }
  return [...resources];
}
```

#### 8. No changes needed

- **`createUserContext()`**: passes `serviceCtx.warehouseId` — works as-is (`undefined` or real promise)
- **Type generator / Vite plugin**: reads env var directly, already handles missing
- **CLI generate-types**: reads env var directly, already handles missing

## Acceptance Criteria

- [x] `createApp({ plugins: [server()] })` succeeds without `DATABRICKS_WAREHOUSE_ID` in production
- [x] `createApp({ plugins: [server(), analytics()] })` fails fast at startup if `DATABRICKS_WAREHOUSE_ID` missing in production
- [x] `createApp({ plugins: [server()] })` in dev mode does NOT fire warehouse discovery API call
- [x] Custom plugins declaring `static requires = ["warehouseId"]` trigger warehouse resolution
- [x] Existing apps with `DATABRICKS_WAREHOUSE_ID` set work identically (backward compatible)
- [x] `getWarehouseId()` throws clear error when no warehouse-requiring plugin was registered
- [x] All existing tests pass
- [ ] New tests cover: server-only startup, analytics startup, missing warehouse error path

## Files to Modify

| File | Change |
|------|--------|
| `packages/shared/src/plugin.ts` | Add `ServiceContextResource` type, add `requires?` to `PluginConstructor` |
| `packages/appkit/src/plugin/plugin.ts` | Add `static requires: ServiceContextResource[] = []` |
| `packages/appkit/src/plugins/analytics/analytics.ts` | Add `static requires = ["warehouseId"]` |
| `packages/appkit/src/context/service-context.ts` | Make `warehouseId` optional, conditionally resolve in `createContext()` |
| `packages/appkit/src/context/user-context.ts` | Make `warehouseId` optional |
| `packages/appkit/src/context/execution-context.ts` | Add `!` assertion in `getWarehouseId()` for optional type |
| `packages/appkit/src/core/appkit.ts` | Add `collectRequiredResources()`, pass to `ServiceContext.initialize()` |
| `tools/test-helpers.ts` | Update mock contexts to handle optional warehouseId |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Custom plugins calling `getWarehouseId()` without `requires` | Returns `undefined` — plugin developer must declare `requires` |
| `PluginConstructor` type change | `requires` is optional — no existing code breaks |
| `ServiceContextState.warehouseId` becoming optional | `getWarehouseId()` uses `!` assertion — safe because startup validation guarantees existence when required |

## Unresolved Questions

1. **Should `workspaceId` also be made conditional?** The `ServiceContextResource` type already includes it for future use. Recommend: leave eager for now, can apply the same pattern later.
