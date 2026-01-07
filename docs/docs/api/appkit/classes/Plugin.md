# Abstract Class: Plugin\<TConfig\>

Defined in: [appkit/src/plugin/plugin.ts:33](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L33)

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

Defined in: [appkit/src/plugin/plugin.ts:54](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L54)

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

Defined in: [appkit/src/plugin/plugin.ts:39](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L39)

***

### cache

```ts
protected cache: CacheManager;
```

Defined in: [appkit/src/plugin/plugin.ts:38](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L38)

***

### config

```ts
protected config: TConfig;
```

Defined in: [appkit/src/plugin/plugin.ts:54](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L54)

***

### devFileReader

```ts
protected devFileReader: DevFileReader;
```

Defined in: [appkit/src/plugin/plugin.ts:40](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L40)

***

### envVars

```ts
abstract protected envVars: string[];
```

Defined in: [appkit/src/plugin/plugin.ts:43](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L43)

***

### isReady

```ts
protected isReady: boolean = false;
```

Defined in: [appkit/src/plugin/plugin.ts:37](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L37)

***

### name

```ts
name: string;
```

Defined in: [appkit/src/plugin/plugin.ts:52](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L52)

#### Implementation of

```ts
BasePlugin.name
```

***

### requiresDatabricksClient

```ts
requiresDatabricksClient: boolean = false;
```

Defined in: [appkit/src/plugin/plugin.ts:46](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L46)

If the plugin requires the Databricks client to be set in the request context

***

### streamManager

```ts
protected streamManager: StreamManager;
```

Defined in: [appkit/src/plugin/plugin.ts:41](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L41)

***

### telemetry

```ts
protected telemetry: ITelemetry;
```

Defined in: [appkit/src/plugin/plugin.ts:42](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L42)

***

### phase

```ts
static phase: PluginPhase = "normal";
```

Defined in: [appkit/src/plugin/plugin.ts:51](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L51)

## Methods

### abortActiveOperations()

```ts
abortActiveOperations(): void;
```

Defined in: [appkit/src/plugin/plugin.ts:79](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L79)

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

Defined in: [appkit/src/plugin/plugin.ts:143](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L143)

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

Defined in: [appkit/src/plugin/plugin.ts:84](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L84)

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

### getEndpoints()

```ts
getEndpoints(): PluginEndpointMap;
```

Defined in: [appkit/src/plugin/plugin.ts:75](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L75)

#### Returns

`PluginEndpointMap`

#### Implementation of

```ts
BasePlugin.getEndpoints
```

***

### injectRoutes()

```ts
injectRoutes(_): void;
```

Defined in: [appkit/src/plugin/plugin.ts:69](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L69)

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
protected registerEndpoint(name, path): void;
```

Defined in: [appkit/src/plugin/plugin.ts:165](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L165)

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
protected route<_TResponse>(router, config): void;
```

Defined in: [appkit/src/plugin/plugin.ts:169](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L169)

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

Defined in: [appkit/src/plugin/plugin.ts:73](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L73)

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

Defined in: [appkit/src/plugin/plugin.ts:65](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L65)

#### Returns

`void`

#### Implementation of

```ts
BasePlugin.validateEnv
```
