# Abstract Class: Plugin\<TConfig\>

Defined in: [app-kit/src/plugin/plugin.ts:32](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L32)

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

Defined in: [app-kit/src/plugin/plugin.ts:50](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L50)

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

Defined in: [app-kit/src/plugin/plugin.ts:38](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L38)

***

### cache

```ts
protected cache: CacheManager;
```

Defined in: [app-kit/src/plugin/plugin.ts:37](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L37)

***

### config

```ts
protected config: TConfig;
```

Defined in: [app-kit/src/plugin/plugin.ts:50](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L50)

***

### devFileReader

```ts
protected devFileReader: DevFileReader;
```

Defined in: [app-kit/src/plugin/plugin.ts:39](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L39)

***

### envVars

```ts
abstract protected envVars: string[];
```

Defined in: [app-kit/src/plugin/plugin.ts:42](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L42)

***

### isReady

```ts
protected isReady: boolean = false;
```

Defined in: [app-kit/src/plugin/plugin.ts:36](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L36)

***

### name

```ts
name: string;
```

Defined in: [app-kit/src/plugin/plugin.ts:48](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L48)

#### Implementation of

```ts
BasePlugin.name
```

***

### requiresDatabricksClient

```ts
requiresDatabricksClient: boolean = false;
```

Defined in: [app-kit/src/plugin/plugin.ts:45](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L45)

If the plugin requires the Databricks client to be set in the request context

***

### streamManager

```ts
protected streamManager: StreamManager;
```

Defined in: [app-kit/src/plugin/plugin.ts:40](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L40)

***

### telemetry

```ts
protected telemetry: ITelemetry;
```

Defined in: [app-kit/src/plugin/plugin.ts:41](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L41)

***

### phase

```ts
static phase: PluginPhase = "normal";
```

Defined in: [app-kit/src/plugin/plugin.ts:47](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L47)

## Methods

### abortActiveOperations()

```ts
abortActiveOperations(): void;
```

Defined in: [app-kit/src/plugin/plugin.ts:71](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L71)

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

Defined in: [app-kit/src/plugin/plugin.ts:135](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L135)

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

Defined in: [app-kit/src/plugin/plugin.ts:76](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L76)

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

Defined in: [app-kit/src/plugin/plugin.ts:65](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L65)

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

### route()

```ts
protected route<_TResponse>(router, config): void;
```

Defined in: [app-kit/src/plugin/plugin.ts:158](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L158)

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

Defined in: [app-kit/src/plugin/plugin.ts:69](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L69)

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

Defined in: [app-kit/src/plugin/plugin.ts:61](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/plugin/plugin.ts#L61)

#### Returns

`void`

#### Implementation of

```ts
BasePlugin.validateEnv
```
