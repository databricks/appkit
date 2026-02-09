# AppKit ServiceContext & Plugin Architecture Learnings

## Overview

This document captures key patterns and learnings about ServiceContext initialization, plugin dependency management, and configuration requirements in the AppKit SDK.

## Key Patterns

### 1. ServiceContext Initialization (Singleton Pattern)

**Location:** `/packages/appkit/src/context/service-context.ts`

**Pattern:** ServiceContext is a singleton that manages the service principal's WorkspaceClient and shared resources.

```typescript
// Initialize once at app startup (safe to call multiple times)
await ServiceContext.initialize();

// Get the initialized context (throws if not initialized)
const ctx = ServiceContext.get();

// Check initialization status
ServiceContext.isInitialized();
```

**Key characteristics:**
- Initialized once at app startup via `createApp()`
- Returns the same instance on multiple calls (idempotent)
- Caches both the instance and the initialization promise
- Throws `InitializationError.notInitialized()` if accessed before initialization

**What it provides:**
- `client`: WorkspaceClient authenticated as service principal
- `serviceUserId`: The service principal's user ID
- `warehouseId`: Promise resolving to warehouse ID (from env or auto-detected)
- `workspaceId`: Promise resolving to workspace ID (from env or API)

### 2. Plugin Initialization Sequence (3 Phases)

**Location:** `/packages/appkit/src/core/appkit.ts`

Plugins initialize in strict order:

1. **Core Phase** (first)
   - Reserved for framework-level plugins
   - Example: Internal system plugins

2. **Normal Phase** (default)
   - Application plugins initialize here
   - Can access other normal plugins via `config.plugins` (deferred only)

3. **Deferred Phase** (last)
   - Initializes after all core and normal plugins
   - Full access to other plugin instances via `config.plugins`
   - Use for plugins that depend on other plugins (e.g., Server Plugin)

```typescript
class MyPlugin extends Plugin {
  static phase: PluginPhase = "deferred";  // Options: "core", "normal", "deferred"
  
  constructor(config: IMyConfig & { plugins?: Record<string, BasePlugin> }) {
    super(config);
    // Can now access config.plugins to reference other plugins
  }
}
```

### 3. Warehouse ID Resolution (Lazy Promises)

**Location:** `/packages/appkit/src/context/service-context.ts` (lines 192-251)

ServiceContext uses lazy promise resolution for warehouse ID:

```typescript
// In ServiceContextState interface
warehouseId: Promise<string>;  // Not awaited during init, resolved lazily

// Resolution logic:
// 1. Try DATABRICKS_WAREHOUSE_ID env var (fastest)
// 2. In development: auto-detect first healthy warehouse
// 3. In production: throw error if not configured
```

**Key insight:** Warehouse ID is NOT required to initialize ServiceContext, but queries will fail if not available. This enables optional analytics plugin scenarios.

**Environment variables:**
- `DATABRICKS_WAREHOUSE_ID`: Explicitly set warehouse (required in production if using analytics)
- `DATABRICKS_WORKSPACE_ID`: Workspace ID (auto-fetched if not set)
- `DATABRICKS_HOST`: Workspace URL (required)

### 4. User Context (asUser Pattern)

**Location:** `/packages/appkit/src/plugin/plugin.ts` (lines 128-160)

Plugins support executing operations as the requesting user:

```typescript
// In route handler
router.post("/my-endpoint", async (req, res) => {
  // Execute query as the user
  const result = await this.asUser(req).myMethod();
});

// Implementation uses AsyncLocalStorage for context propagation
const userContext = ServiceContext.createUserContext(token, userId);
return runInUserContext(userContext, () => userPlugin.method());
```

**Headers required:**
- `x-forwarded-access-token`: User's OAuth/PAT token (required in production)
- `x-forwarded-user`: User ID (required in production)

**Development behavior:** Falls back to service principal if token unavailable (logs warning)

### 5. Execution Context Pattern

**Location:** `/packages/appkit/src/context/execution-context.ts`

Two-tier context system:

```typescript
// Service context (singleton, initialized at startup)
const serviceCtx = ServiceContext.get();

// Execution context (current request scope)
const ctx = getExecutionContext();  // Returns user OR service context

// Helper functions
getCurrentUserId();      // User ID or service principal ID
getWorkspaceClient();    // Appropriate client for current context
getWarehouseId();        // Promise<string>
getWorkspaceId();        // Promise<string>
isInUserContext();       // boolean
```

**Pattern:** Execution context is determined at request time via AsyncLocalStorage, enabling seamless user-scoped operations without explicit parameter passing.

### 6. Plugin Dependencies via Config

**Location:** `/packages/appkit/src/core/appkit.ts` (lines 46-52)

Deferred plugins receive other plugin instances:

```typescript
// During plugin creation, deferred plugins get:
const extraData = { plugins: this.#pluginInstances };

// Plugin constructor receives merged config:
constructor(config: IPluginConfig & { plugins?: Record<string, BasePlugin> }) {
  super(config);
  // Can access: this.config.plugins.somePlugin
}
```

## Optional Dependencies Pattern

Based on the codebase analysis, here's the recommended pattern for optional plugins:

### Pattern: Optional Warehouse

```typescript
class MyPlugin extends Plugin {
  protected envVars = [];  // Empty = no required env vars
  
  constructor(config: IMyConfig) {
    super(config);
  }
  
  async myQueryMethod() {
    try {
      const warehouseId = await getWarehouseId();
      // Use warehouse...
    } catch (error) {
      if (error instanceof ConfigurationError) {
        throw new InitializationError(
          "Warehouse not configured. Set DATABRICKS_WAREHOUSE_ID in app.yaml",
          { cause: error }
        );
      }
      throw error;
    }
  }
}
```

### Pattern: Optional Plugin Dependency

```typescript
class MyPlugin extends Plugin {
  static phase: PluginPhase = "deferred";
  
  constructor(config: IMyConfig & { plugins?: Record<string, BasePlugin> }) {
    super(config);
    this.analyticsPlugin = config.plugins?.analytics;
  }
  
  async getAnalytics() {
    if (!this.analyticsPlugin) {
      throw new InitializationError("Analytics plugin not configured");
    }
    return this.analyticsPlugin.query("...");
  }
}
```

## Configuration Hierarchy

**Creation flow:**
```
createApp({
  plugins: [...],
  telemetry?: TelemetryConfig,
  cache?: CacheConfig
})
  ↓
TelemetryManager.initialize(config?.telemetry)
CacheManager.getInstance(config?.cache)
ServiceContext.initialize()  // ← Fails here if auth misconfigured
  ↓
Plugin instantiation (Core → Normal → Deferred)
  ↓
Plugin.setup() called for each plugin
```

## Error Handling Patterns

**InitializationError:**
- Thrown when accessing services before ready
- Used for setup failures and missing required resources
- Has special factory methods: `notInitialized()`, `setupFailed()`, `migrationFailed()`

**ConfigurationError:**
- Thrown for missing env vars or environment misconfigurations
- Includes hints for resolution

## Important Implementation Details

1. **ServiceContext is eager**: Initialized at app startup before plugins, not lazy
2. **Warehouse ID is lazy**: Promise-based, resolved on first use
3. **Plugin setup() is sequential**: All await in parallel via `Promise.all()`
4. **asUser() uses Proxy**: Wraps method calls to inject user context
5. **EXCLUDED_FROM_PROXY**: Lifecycle methods don't wrap (`setup`, `shutdown`, `validateEnv`, etc.)
6. **Development mode fallback**: asUser() falls back to service principal in dev if token missing

## Common Mistakes to Avoid

1. **Accessing ServiceContext before initialize()**: Will throw InitializationError
2. **Missing DATABRICKS_HOST**: ServiceContext.initialize() will fail
3. **Assuming warehouse in production**: Must configure DATABRICKS_WAREHOUSE_ID in app.yaml
4. **Using getWarehouseId() synchronously**: It's always a Promise
5. **Forgetting plugin phase**: Normal plugins can't reliably access other plugins
6. **asUser() without proper headers**: Will throw AuthenticationError in production

## File References

Key source files for reference:
- `/packages/appkit/src/context/service-context.ts` - ServiceContext implementation
- `/packages/appkit/src/context/execution-context.ts` - Execution context helpers
- `/packages/appkit/src/core/appkit.ts` - Plugin initialization sequence
- `/packages/appkit/src/plugin/plugin.ts` - Plugin base class with asUser pattern
- `/docs/docs/plugins.md` - Plugin system documentation
- `/docs/docs/configuration.mdx` - Environment variable reference
