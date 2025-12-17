# Abstract Class: Plugin\<TConfig\>

Defined in: [app-kit/src/plugin/plugin.ts:71](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L71)

Base class for all App Kit plugins.

Plugins are the building blocks of App Kit applications. They provide functionality
like serving HTTP endpoints, executing SQL queries, or custom business logic.

Plugins have access to:
- Cache manager for data caching
- Telemetry for observability
- Stream manager for SSE responses
- App manager for query access

## Example

Creating a custom plugin
```typescript
import { Plugin, toPlugin } from '@databricks/app-kit';

class MyPlugin extends Plugin {
  name = 'my-plugin';
  envVars = ['MY_API_KEY'];

  async setup() {
    console.log('Plugin initialized');
  }

  injectRoutes(router) {
    this.route(router, {
      method: 'get',
      path: '/hello',
      handler: async (req, res) => {
        res.json({ message: 'Hello from my plugin!' });
      }
    });
  }
}

export const myPlugin = toPlugin(MyPlugin, 'my-plugin');
```

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TConfig` *extends* [`BasePluginConfig`](../interfaces/BasePluginConfig.md) | [`BasePluginConfig`](../interfaces/BasePluginConfig.md) |

## Implements

- `BasePlugin`

## Constructors

### Constructor

```ts
new Plugin<TConfig>(config): Plugin<TConfig>;
```

Defined in: [app-kit/src/plugin/plugin.ts:89](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L89)

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

Defined in: [app-kit/src/plugin/plugin.ts:77](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L77)

***

### cache

```ts
protected cache: CacheManager;
```

Defined in: [app-kit/src/plugin/plugin.ts:76](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L76)

***

### config

```ts
protected config: TConfig;
```

Defined in: [app-kit/src/plugin/plugin.ts:89](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L89)

***

### devFileReader

```ts
protected devFileReader: DevFileReader;
```

Defined in: [app-kit/src/plugin/plugin.ts:78](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L78)

***

### envVars

```ts
abstract protected envVars: string[];
```

Defined in: [app-kit/src/plugin/plugin.ts:81](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L81)

***

### isReady

```ts
protected isReady: boolean = false;
```

Defined in: [app-kit/src/plugin/plugin.ts:75](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L75)

***

### name

```ts
name: string;
```

Defined in: [app-kit/src/plugin/plugin.ts:87](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L87)

#### Implementation of

```ts
BasePlugin.name
```

***

### requiresDatabricksClient

```ts
requiresDatabricksClient: boolean = false;
```

Defined in: [app-kit/src/plugin/plugin.ts:84](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L84)

If the plugin requires the Databricks client to be set in the request context

***

### streamManager

```ts
protected streamManager: StreamManager;
```

Defined in: [app-kit/src/plugin/plugin.ts:79](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L79)

***

### telemetry

```ts
protected telemetry: ITelemetry;
```

Defined in: [app-kit/src/plugin/plugin.ts:80](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L80)

***

### phase

```ts
static phase: PluginPhase = "normal";
```

Defined in: [app-kit/src/plugin/plugin.ts:86](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L86)

## Methods

### abortActiveOperations()

```ts
abortActiveOperations(): void;
```

Defined in: [app-kit/src/plugin/plugin.ts:146](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L146)

#### Returns

`void`

#### Implementation of

```ts
BasePlugin.abortActiveOperations
```

***

### execute()

```ts
protected execute<T>(
   fn, 
   options, 
userKey): Promise<T | undefined>;
```

Defined in: [app-kit/src/plugin/plugin.ts:210](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L210)

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fn` | (`signal?`) => `Promise`\<`T`\> |
| `options` | `PluginExecutionSettings` |
| `userKey` | `string` |

#### Returns

`Promise`\<`T` \| `undefined`\>

***

### executeStream()

```ts
protected executeStream<T>(
   res, 
   fn, 
   options, 
userKey): Promise<void>;
```

Defined in: [app-kit/src/plugin/plugin.ts:151](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L151)

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `res` | `IAppResponse` |
| `fn` | `StreamExecuteHandler`\<`T`\> |
| `options` | [`StreamExecutionSettings`](../interfaces/StreamExecutionSettings.md) |
| `userKey` | `string` |

#### Returns

`Promise`\<`void`\>

***

### injectRoutes()

```ts
injectRoutes(_): void;
```

Defined in: [app-kit/src/plugin/plugin.ts:127](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L127)

Inject HTTP routes for the plugin.
Override this method to add custom routes to the Express router.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `_` | `Router` |

#### Returns

`void`

#### Example

```typescript
injectRoutes(router) {
  this.route(router, {
    method: 'get',
    path: '/status',
    handler: async (req, res) => {
      res.json({ status: 'ok' });
    }
  });
}
```

#### Implementation of

```ts
BasePlugin.injectRoutes
```

***

### route()

```ts
protected route<_TResponse>(router, config): void;
```

Defined in: [app-kit/src/plugin/plugin.ts:233](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L233)

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

Defined in: [app-kit/src/plugin/plugin.ts:144](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L144)

Plugin setup lifecycle hook.
Override this method to perform async initialization (e.g., database connections).
Called after all plugins are instantiated but before the server starts.

#### Returns

`Promise`\<`void`\>

#### Example

```typescript
async setup() {
  await this.initializeDatabase();
  console.log('Plugin ready');
}
```

#### Implementation of

```ts
BasePlugin.setup
```

***

### validateEnv()

```ts
validateEnv(): void;
```

Defined in: [app-kit/src/plugin/plugin.ts:104](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L104)

Validates required environment variables for the plugin.
Called automatically during plugin initialization.

#### Returns

`void`

#### Implementation of

```ts
BasePlugin.validateEnv
```
