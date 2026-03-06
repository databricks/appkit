# Abstract Class: Plugin\<TConfig\>

Base abstract class for creating AppKit plugins.

All plugins must declare a static `manifest` property with their metadata
and resource requirements. The manifest defines:
- `required` resources: Always needed for the plugin to function
- `optional` resources: May be needed depending on plugin configuration

## Static vs Runtime Resource Requirements

The manifest is static and doesn't know the plugin's runtime configuration.
For resources that become required based on config options, plugins can
implement a static `getResourceRequirements(config)` method.

At runtime, this method is called with the actual config to determine
which "optional" resources should be treated as "required".

## Examples

```typescript
import { Plugin, toPlugin, PluginManifest, ResourceType } from '@databricks/appkit';

const myManifest: PluginManifest = {
  name: 'myPlugin',
  displayName: 'My Plugin',
  description: 'Does something awesome',
  resources: {
    required: [
      { type: ResourceType.SQL_WAREHOUSE, alias: 'warehouse', ... }
    ],
    optional: []
  }
};

class MyPlugin extends Plugin<MyConfig> {
  static manifest = myManifest;
}
```

```typescript
interface MyConfig extends BasePluginConfig {
  enableCaching?: boolean;
}

const myManifest: PluginManifest = {
  name: 'myPlugin',
  resources: {
    required: [
      { type: ResourceType.SQL_WAREHOUSE, alias: 'warehouse', ... }
    ],
    optional: [
      // Database is optional in the static manifest
      { type: ResourceType.DATABASE, alias: 'cache', description: 'Required if caching enabled', ... }
    ]
  }
};

class MyPlugin extends Plugin<MyConfig> {
  static manifest = myManifest<"myPlugin">;

  // Runtime method: converts optional resources to required based on config
  static getResourceRequirements(config: MyConfig) {
    const resources = [];
    if (config.enableCaching) {
      // When caching is enabled, Database becomes required
      resources.push({
        type: ResourceType.DATABASE,
        alias: 'cache',
        resourceKey: 'database',
        description: 'Cache storage for query results',
        permission: 'CAN_CONNECT_AND_CREATE',
        fields: {
          instance_name: { env: 'DATABRICKS_CACHE_INSTANCE' },
          database_name: { env: 'DATABRICKS_CACHE_DB' },
        },
        required: true  // Mark as required at runtime
      });
    }
    return resources;
  }
}
```

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TConfig` *extends* [`BasePluginConfig`](Interface.BasePluginConfig.md) | [`BasePluginConfig`](Interface.BasePluginConfig.md) |

## Implements

- `BasePlugin`

## Constructors

### Constructor

```ts
new Plugin<TConfig>(config: TConfig): Plugin<TConfig>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | `TConfig` |

#### Returns

`Plugin`\<`TConfig`\>

## Properties

### app

```ts
protected app: AppManager;
```

***

### cache

```ts
protected cache: CacheManager;
```

***

### config

```ts
protected config: TConfig;
```

***

### devFileReader

```ts
protected devFileReader: DevFileReader;
```

***

### isReady

```ts
protected isReady: boolean = false;
```

***

### name

```ts
name: string;
```

Plugin name identifier.

#### Implementation of

```ts
BasePlugin.name
```

***

### streamManager

```ts
protected streamManager: StreamManager;
```

***

### telemetry

```ts
protected telemetry: ITelemetry;
```

***

### phase

```ts
static phase: PluginPhase = "normal";
```

Plugin initialization phase.
- 'core': Initialized first (e.g., config plugins)
- 'normal': Initialized second (most plugins)
- 'deferred': Initialized last (e.g., server plugin)

## Methods

### abortActiveOperations()

```ts
abortActiveOperations(): void;
```

#### Returns

`void`

#### Implementation of

```ts
BasePlugin.abortActiveOperations
```

***

### asUser()

```ts
asUser(req: Request): this;
```

Execute operations using the user's identity from the request.
Returns a proxy of this plugin where all method calls execute
with the user's Databricks credentials instead of the service principal.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `req` | `Request` | The Express request containing the user token in headers |

#### Returns

`this`

A proxied plugin instance that executes as the user

#### Throws

AuthenticationError if user token is not available in request headers (production only).
  In development mode (`NODE_ENV=development`), falls back to the service principal instead of throwing.

***

### execute()

```ts
protected execute<T>(
   fn: (signal?: AbortSignal) => Promise<T>, 
   options: PluginExecutionSettings, 
userKey?: string): Promise<T | undefined>;
```

Execute a function with the plugin's interceptor chain.

All errors are caught and `undefined` is returned (production-safe).
Route handlers should check for `undefined` and respond with an
appropriate error status.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fn` | (`signal?`: `AbortSignal`) => `Promise`\<`T`\> |
| `options` | `PluginExecutionSettings` |
| `userKey?` | `string` |

#### Returns

`Promise`\<`T` \| `undefined`\>

***

### executeStream()

```ts
protected executeStream<T>(
   res: IAppResponse, 
   fn: StreamExecuteHandler<T>, 
   options: StreamExecutionSettings, 
userKey?: string): Promise<void>;
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `res` | `IAppResponse` |
| `fn` | `StreamExecuteHandler`\<`T`\> |
| `options` | [`StreamExecutionSettings`](Interface.StreamExecutionSettings.md) |
| `userKey?` | `string` |

#### Returns

`Promise`\<`void`\>

***

### exports()

```ts
exports(): unknown;
```

Returns the public exports for this plugin.
Override this to define a custom public API.
By default, returns an empty object.

The returned object becomes the plugin's public API on the AppKit instance
(e.g. `appkit.myPlugin.method()`). AppKit automatically binds method context
and adds `asUser(req)` for user-scoped execution.

#### Returns

`unknown`

#### Example

```ts
class MyPlugin extends Plugin {
  private getData() { return []; }

  exports() {
    return { getData: this.getData };
  }
}

// After registration:
const appkit = await createApp({ plugins: [myPlugin()] });
appkit.myPlugin.getData();
```

#### Implementation of

```ts
BasePlugin.exports
```

***

### getEndpoints()

```ts
getEndpoints(): PluginEndpointMap;
```

#### Returns

`PluginEndpointMap`

#### Implementation of

```ts
BasePlugin.getEndpoints
```

***

### getSkipBodyParsingPaths()

```ts
getSkipBodyParsingPaths(): ReadonlySet<string>;
```

#### Returns

`ReadonlySet`\<`string`\>

#### Implementation of

```ts
BasePlugin.getSkipBodyParsingPaths
```

***

### injectRoutes()

```ts
injectRoutes(_: Router): void;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `_` | `Router` |

#### Returns

`void`

#### Implementation of

```ts
BasePlugin.injectRoutes
```

***

### registerEndpoint()

```ts
protected registerEndpoint(name: string, path: string): void;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |
| `path` | `string` |

#### Returns

`void`

***

### resolveUserId()

```ts
protected resolveUserId(req: Request): string;
```

Resolve the effective user ID from a request.

Returns the `x-forwarded-user` header when present. In development mode
(`NODE_ENV=development`) falls back to the current context user ID so
that callers outside an active `runInUserContext` scope still get a
consistent value.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `req` | `Request` |

#### Returns

`string`

#### Throws

AuthenticationError in production when no user header is present.

***

### route()

```ts
protected route<_TResponse>(router: Router, config: RouteConfig): void;
```

#### Type Parameters

| Type Parameter |
| ------ |
| `_TResponse` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `router` | `Router` |
| `config` | `RouteConfig` |

#### Returns

`void`

***

### setup()

```ts
setup(): Promise<void>;
```

#### Returns

`Promise`\<`void`\>

#### Implementation of

```ts
BasePlugin.setup
```
