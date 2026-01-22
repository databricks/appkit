# Abstract Class: Plugin\<TConfig\>

Defined in: appkit/src/plugin/plugin.ts:62

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

Defined in: appkit/src/plugin/plugin.ts:80

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

Defined in: appkit/src/plugin/plugin.ts:68

***

### cache

```ts
protected cache: CacheManager;
```

Defined in: appkit/src/plugin/plugin.ts:67

***

### config

```ts
protected config: TConfig;
```

Defined in: appkit/src/plugin/plugin.ts:80

***

### devFileReader

```ts
protected devFileReader: DevFileReader;
```

Defined in: appkit/src/plugin/plugin.ts:69

***

### envVars

```ts
abstract protected envVars: string[];
```

Defined in: appkit/src/plugin/plugin.ts:72

***

### isReady

```ts
protected isReady: boolean = false;
```

Defined in: appkit/src/plugin/plugin.ts:66

***

### name

```ts
name: string;
```

Defined in: appkit/src/plugin/plugin.ts:78

#### Implementation of

```ts
BasePlugin.name
```

***

### streamManager

```ts
protected streamManager: StreamManager;
```

Defined in: appkit/src/plugin/plugin.ts:70

***

### telemetry

```ts
protected telemetry: ITelemetry;
```

Defined in: appkit/src/plugin/plugin.ts:71

***

### phase

```ts
static phase: PluginPhase = "normal";
```

Defined in: appkit/src/plugin/plugin.ts:77

## Methods

### abortActiveOperations()

```ts
abortActiveOperations(): void;
```

Defined in: appkit/src/plugin/plugin.ts:105

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

Defined in: appkit/src/plugin/plugin.ts:138

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

Defined in: appkit/src/plugin/plugin.ts:260

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

Defined in: appkit/src/plugin/plugin.ts:198

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

Defined in: appkit/src/plugin/plugin.ts:101

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

Defined in: appkit/src/plugin/plugin.ts:95

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

Defined in: appkit/src/plugin/plugin.ts:285

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

Defined in: appkit/src/plugin/plugin.ts:289

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

Defined in: appkit/src/plugin/plugin.ts:99

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

Defined in: appkit/src/plugin/plugin.ts:91

#### Returns

`void`

#### Implementation of

```ts
BasePlugin.validateEnv
```
