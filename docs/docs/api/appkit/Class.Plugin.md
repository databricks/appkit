# Abstract Class: Plugin\<TConfig\>

Base abstract class for creating AppKit plugins

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

### envVars

```ts
abstract protected envVars: string[];
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

Returns a scoped instance of this plugin where all method calls
will execute with the user's Databricks credentials instead of
the service principal.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `req` | `Request` | The Express request containing the user token in headers |

#### Returns

`this`

A scoped plugin instance that executes as the user

#### Throws

Error if user token is not available in request headers

#### Example

```typescript
// In route handler - execute query as the requesting user
router.post('/users/me/query/:key', async (req, res) => {
  const result = await this.asUser(req).query(req.params.key)
  res.json(result)
})

// Mixed execution in same handler
router.post('/dashboard', async (req, res) => {
  const [systemData, userData] = await Promise.all([
    this.getSystemStats(),                  // Service principal
    this.asUser(req).getUserPreferences(), // User context
  ])
  res.json({ systemData, userData })
})
```

***

### execute()

```ts
protected execute<T>(
   fn: (signal?: AbortSignal) => Promise<T>, 
   options: PluginExecutionSettings, 
userKey?: string): Promise<T | undefined>;
```

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

***

### validateEnv()

```ts
validateEnv(): void;
```

#### Returns

`void`

#### Implementation of

```ts
BasePlugin.validateEnv
```
