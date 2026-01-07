# Abstract Class: Plugin\<TConfig\>

Defined in: [appkit/src/plugin/plugin.ts:33](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L33)

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TConfig` *extends* `BasePluginConfig` | `BasePluginConfig` |

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

### requiresDatabricksClient

```ts
requiresDatabricksClient: boolean = false;
```

Defined in: [appkit/src/plugin/plugin.ts:46](https://github.com/databricks/appkit/blob/main/packages/appkit/src/plugin/plugin.ts#L46)

If the plugin requires the Databricks client to be set in the request context

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
| `options` | `StreamExecutionSettings` |
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
