# Create a Core Plugin for AppKit

User input: $ARGUMENTS

## 1. Gather Requirements

The user may have provided a plugin name and/or description above in `$ARGUMENTS`. Parse what was given.

**If a plugin name was provided**, use it (convert to kebab-case if needed). **If no name was provided or `$ARGUMENTS` is empty**, ask the user:

> What should the plugin be called? (kebab-case, e.g. `model-serving`, `vector-search`, `feature-store`)

Then, ask the user the following questions to determine how to build the plugin. Batch these into a single message — don't ask one at a time:

1. **What does this plugin do?** — Brief description of the plugin's purpose (e.g. "Executes queries against a SQL warehouse", "Manages Genie AI/BI conversations")
2. **Which Databricks service does it interact with?** — e.g. SQL Warehouse, Genie, Model Serving, Vector Search, Unity Catalog, or none (utility plugin)
3. **Does it need to stream responses to the client?** — If yes, the plugin will use `executeStream()` with SSE. If no, it will use `execute()` for standard request-response.
4. **What routes should it expose?** — e.g. `POST /query`, `GET /status/:id`, `POST /messages` — or none if it only exposes a programmatic API via `exports()`
5. **Does it need async initialization?** — e.g. creating a connection pool, warming a cache, loading config from an API. If yes, the plugin will override `setup()`.
6. **Does it need to perform operations on behalf of the logged-in user (OBO)?** — If yes, route handlers will use `this.asUser(req)` to proxy API calls with the user's Databricks credentials instead of the service principal's.

Use the answers to determine:
- Whether a **connector** is needed (yes if it talks to a Databricks API)
- What **Databricks resources** to declare in the manifest (SQL warehouses, Genie spaces, etc. — or none)
- What **user API scopes** are required for OBO (see section 4f)
- Whether to use **streaming** (`executeStream`) or **standard** (`execute`) execution
- What **defaults** to set (cache/retry/timeout)

## 2. Scaffold with the CLI

Run the scaffolding command to generate boilerplate. Pipe answers non-interactively if possible, or run it interactively:

```bash
npx @databricks/appkit plugin create
```

Select **In-repo** placement and target path `packages/appkit/src/plugins/{name}`. Fill in the name, display name, description, and resources based on the gathered requirements.

This generates `manifest.json`, the plugin class file, and `index.ts`. Then enhance the generated files following the patterns below.

## 3. File Structure

Every core plugin lives in `packages/appkit/src/plugins/{name}/` with this layout:

```
plugins/{name}/
├── manifest.json       # Resource requirements and metadata
├── {name}.ts           # Main plugin class
├── index.ts            # Re-exports: plugin class + types
├── types.ts            # Config interface, request/response types
├── defaults.ts         # Default execution settings (cache, retry, timeout)
└── tests/
    └── {name}.test.ts
```

If the plugin needs a connector, add it under `packages/appkit/src/connectors/{name}/`:

```
connectors/{name}/
├── client.ts           # Connector class
├── defaults.ts         # Connector-specific defaults
├── types.ts            # Connector types
└── index.ts            # Re-exports
```

## 4. Plugin Patterns to Follow

### 4a. Config Interface (`types.ts`)

Extend `BasePluginConfig` from `shared`:

```typescript
import type { BasePluginConfig } from "shared";

export interface I{PascalName}Config extends BasePluginConfig {
  timeout?: number;
}
```

`BasePluginConfig` already includes `name?`, `host?`, `telemetry?`, and `[key: string]: unknown`.

### 4b. Defaults (`defaults.ts`)

For standard execution:

```typescript
import type { PluginExecuteConfig } from "shared";

export const {camelName}Defaults: PluginExecuteConfig = {
  cache: { enabled: true, ttl: 3600 },
  retry: { enabled: true, initialDelay: 1500, attempts: 3 },
  timeout: 18000,
};
```

For streaming execution:

```typescript
import type { StreamExecutionSettings } from "shared";

export const {camelName}StreamDefaults: StreamExecutionSettings = {
  default: {
    cache: { enabled: false },
    retry: { enabled: false },
    timeout: 120_000,
  },
  stream: { bufferSize: 100 },
};
```

Disable cache for non-idempotent operations. Disable retry for side-effect operations.

### 4c. Connector (`connectors/{name}/client.ts`)

Only create if the plugin interacts with a Databricks API. Connectors abstract SDK calls. Critical rules:
- **Receive `WorkspaceClient` per-call** — never store it. This allows `asUser()` proxying to work.
- Accept `AbortSignal` for cancellation.
- Keep connectors stateless (no request-scoped state).

```typescript
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { createLogger } from "../../logging/logger";

const logger = createLogger("connectors:{name}");

export interface {PascalName}ConnectorConfig {
  timeout?: number;
}

export class {PascalName}Connector {
  private readonly config: Required<{PascalName}ConnectorConfig>;

  constructor(config: {PascalName}ConnectorConfig = {}) {
    this.config = {
      timeout: config.timeout ?? 30_000,
    };
  }

  async doSomething(
    workspaceClient: WorkspaceClient,
    input: SomeInput,
    signal?: AbortSignal,
  ): Promise<SomeOutput> {
    // Use workspaceClient to call Databricks APIs
  }
}
```

### 4d. Plugin Class (`{name}.ts`)

The plugin class ties everything together. Follow this exact pattern:

```typescript
import type express from "express";
import type { IAppRouter } from "shared";
import { {PascalName}Connector } from "../../connectors";
import { getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { {camelName}Defaults } from "./defaults";
import manifest from "./manifest.json";
import type { I{PascalName}Config } from "./types";

const logger = createLogger("{name}");

export class {PascalName}Plugin extends Plugin {
  name = "{name}";
  static manifest = manifest as PluginManifest;
  protected declare config: I{PascalName}Config;

  private connector: {PascalName}Connector;

  constructor(config: I{PascalName}Config) {
    super(config);
    this.config = config;
    this.connector = new {PascalName}Connector({ timeout: config.timeout });
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "doSomething",
      method: "post",
      path: "/do-something",
      handler: async (req: express.Request, res: express.Response) => {
        await this.asUser(req)._handleDoSomething(req, res);
      },
    });
  }

  async _handleDoSomething(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const workspaceClient = getWorkspaceClient();
    // Use this.execute() or this.executeStream() with defaults
  }

  async doSomething(input: SomeInput): Promise<SomeOutput> {
    const workspaceClient = getWorkspaceClient();
    return this.connector.doSomething(workspaceClient, input);
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  exports() {
    return {
      doSomething: this.doSomething,
    };
  }
}

export const {camelName} = toPlugin<
  typeof {PascalName}Plugin,
  I{PascalName}Config,
  "{name}"
>({PascalName}Plugin, "{name}");
```

Required elements:
- `name` — matches manifest name
- `static manifest` — cast `manifest.json` import as `PluginManifest`
- `protected declare config` — typed with the plugin's config interface
- `constructor` — calls `super(config)`, sets `this.config`, initializes connectors
- `injectRoutes()` — registers routes with `this.route(router, {...})`
- `exports()` — returns the public API (accessible as `AppKit.{pluginName}`)
- `toPlugin()` call at the bottom — factory export

### 4e. Manifest (`manifest.json`)

```json
{
  "$schema": "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json",
  "name": "{name}",
  "displayName": "{DisplayName}",
  "description": "{description}",
  "resources": {
    "required": [],
    "optional": []
  }
}
```

Add resources as needed. Resource types: `sql_warehouse`, `genie_space`, and others defined by the Databricks Apps platform.

Example resource entry:
```json
{
  "type": "sql_warehouse",
  "alias": "SQL Warehouse",
  "resourceKey": "sql-warehouse",
  "description": "SQL Warehouse for executing queries",
  "permission": "CAN_USE",
  "fields": {
    "id": {
      "env": "DATABRICKS_WAREHOUSE_ID",
      "description": "SQL Warehouse ID"
    }
  }
}
```

### 4f. User API Scopes (OBO)

If the plugin performs operations on behalf of the logged-in user via `this.asUser(req)`, it requires one or more `user_api_scopes` in the Databricks Apps bundle config (`databricks.yml`). Without the correct scopes, OBO calls will fail at runtime.

**Available scopes:**

| Scope | When to use |
|-------|-------------|
| `sql` | Plugin executes SQL queries on behalf of the user (e.g. analytics `.obo.sql` files) |
| `dashboards.genie` | Plugin interacts with Genie AI/BI spaces on behalf of the user |
| `files.files` | Plugin reads/writes files on behalf of the user |

**How to determine required scopes:**
- If the plugin calls SQL Statement Execution APIs as the user → `sql`
- If the plugin calls Genie/Dashboard APIs as the user → `dashboards.genie`
- If the plugin calls Files API as the user → `files.files`
- If the plugin only uses the service principal (no `asUser()`) → no scopes needed

**Wiring scopes into the bundle template:**

The Databricks Apps bundle config at `template/databricks.yml.tmpl` must include the plugin's scopes under `user_api_scopes`. Currently, scopes are driven by template conditionals (e.g. `{{- if .plugins.genie}}`). When adding a new plugin that requires OBO:

1. Add a conditional block to `template/databricks.yml.tmpl` that emits the required `user_api_scopes` when the plugin is selected
2. If the plugin's scope is already listed (e.g. another plugin uses `sql`), ensure it's not duplicated — the template should emit a unified list

Example addition to `databricks.yml.tmpl`:
```yaml
{{- if .plugins.myPlugin}}
      user_api_scopes:
        - sql
{{- end}}
```

If multiple plugins need different scopes, the template logic should merge them into a single `user_api_scopes` list.

### 4g. Index (`index.ts`)

```typescript
export * from "./{name}";
export * from "./types";
```

## 5. Register the Plugin

Add the plugin to `packages/appkit/src/plugins/index.ts`:

```typescript
export * from "./{name}";
```

If a connector was created, add it to `packages/appkit/src/connectors/index.ts`:

```typescript
export * from "./{name}";
```

## 6. Key Conventions

### Route Registration
Routes mount at `/api/{pluginName}/...`. Use `this.route(router, { name, method, path, handler })`.

### User-Scoped Execution (OBO)
`this.asUser(req)` returns a proxy where all method calls use the user's Databricks credentials. Use it in route handlers for user-scoped operations. Inside the proxied method, `getWorkspaceClient()` automatically returns the user-scoped client. **Important:** any plugin using `asUser()` must declare the appropriate `user_api_scopes` in the bundle config — see section 4f.

### Execution Methods
- `this.execute(fn, options)` — single request-response with interceptors (telemetry, timeout, retry, cache)
- `this.executeStream(res, fn, options)` — SSE streaming with interceptors

### Context Utilities
Import from `../../context`:
- `getWorkspaceClient()` — returns `WorkspaceClient` for current context (service principal or user-scoped)
- `getWarehouseId()` — returns the configured SQL warehouse ID
- `getCurrentUserId()` — returns current user ID

### Logging
Use `createLogger("plugin-name")` from `../../logging/logger`.

### Setup/Teardown
- Override `setup()` for async init (e.g., connection pools). Called by AppKit during startup.
- Override `abortActiveOperations()` for cleanup. Call `super.abortActiveOperations()` first.

### Plugin Phases
Set `static phase: PluginPhase` if needed: `"core"` (first), `"normal"` (default), `"deferred"` (last).

## 7. After Scaffolding

Run these to verify:

```bash
pnpm build
pnpm typecheck
pnpm test
npx @databricks/appkit plugin sync --write
```
