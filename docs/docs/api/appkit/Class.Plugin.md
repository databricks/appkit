# Abstract Class: Plugin\<TConfig\>

Defined in: [appkit/src/plugin/plugin.ts:63](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L63)

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

Defined in: [appkit/src/plugin/plugin.ts:81](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L81)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | `TConfig` |

#### Returns

`Plugin`\<`TConfig`\>

## Properties

### \_envVars

```ts
abstract protected _envVars: string[];
```

Defined in: [appkit/src/plugin/plugin.ts:73](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L73)

***

### app

```ts
protected app: AppManager;
```

Defined in: [appkit/src/plugin/plugin.ts:69](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L69)

***

### cache

```ts
protected cache: CacheManager;
```

Defined in: [appkit/src/plugin/plugin.ts:68](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L68)

***

### config

```ts
protected config: TConfig;
```

Defined in: [appkit/src/plugin/plugin.ts:81](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L81)

***

### devFileReader

```ts
protected devFileReader: DevFileReader;
```

Defined in: [appkit/src/plugin/plugin.ts:70](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L70)

***

### isReady

```ts
protected isReady: boolean = false;
```

Defined in: [appkit/src/plugin/plugin.ts:67](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L67)

***

### name

```ts
name: string;
```

Defined in: [appkit/src/plugin/plugin.ts:79](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L79)

#### Implementation of

```ts
BasePlugin.name
```

***

### streamManager

```ts
protected streamManager: StreamManager;
```

Defined in: [appkit/src/plugin/plugin.ts:71](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L71)

***

### telemetry

```ts
protected telemetry: ITelemetry;
```

Defined in: [appkit/src/plugin/plugin.ts:72](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L72)

***

### phase

```ts
static phase: PluginPhase = "normal";
```

Defined in: [appkit/src/plugin/plugin.ts:78](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L78)

## Methods

### \_abortActiveOperations()

```ts
_abortActiveOperations(): void;
```

Defined in: [appkit/src/plugin/plugin.ts:106](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L106)

#### Returns

`void`

#### Implementation of

```ts
BasePlugin._abortActiveOperations
```

***

### \_getEndpoints()

```ts
_getEndpoints(): PluginEndpointMap;
```

Defined in: [appkit/src/plugin/plugin.ts:102](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L102)

#### Returns

`PluginEndpointMap`

#### Implementation of

```ts
BasePlugin._getEndpoints
```

***

### \_injectRoutes()

```ts
_injectRoutes(_: Router): void;
```

Defined in: [appkit/src/plugin/plugin.ts:96](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L96)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `_` | `Router` |

#### Returns

`void`

#### Implementation of

```ts
BasePlugin._injectRoutes
```

***

### \_setup()

```ts
_setup(): Promise<void>;
```

Defined in: [appkit/src/plugin/plugin.ts:100](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L100)

#### Returns

`Promise`\<`void`\>

#### Implementation of

```ts
BasePlugin._setup
```

***

### \_validateEnv()

```ts
_validateEnv(): void;
```

Defined in: [appkit/src/plugin/plugin.ts:92](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L92)

#### Returns

`void`

#### Implementation of

```ts
BasePlugin._validateEnv
```

***

### asUser()

```ts
asUser(req: Request): UserScopedPluginAPI<this>;
```

Defined in: [appkit/src/plugin/plugin.ts:139](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L139)

Execute operations using the user's identity from the request.

Returns a scoped instance of this plugin where all method calls
will execute with the user's Databricks credentials instead of
the service principal.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `req` | `Request` | The Express request containing the user token in headers |

#### Returns

`UserScopedPluginAPI`\<`this`\>

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

Defined in: [appkit/src/plugin/plugin.ts:263](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L263)

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

Defined in: [appkit/src/plugin/plugin.ts:201](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L201)

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

### registerEndpoint()

```ts
protected registerEndpoint(name: string, path: string): void;
```

Defined in: [appkit/src/plugin/plugin.ts:288](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L288)

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

Defined in: [appkit/src/plugin/plugin.ts:292](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L292)

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
