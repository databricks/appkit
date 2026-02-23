# Class: LakebasePlugin

AppKit plugin for Databricks Lakebase Autoscaling.

Wraps `@databricks/lakebase` to provide a standard `pg.Pool` with automatic
OAuth token refresh, integrated with AppKit's logger and OpenTelemetry setup.

## Example

```ts
import { createApp, lakebase, server } from "@databricks/appkit";

const AppKit = await createApp({
  plugins: [server(), lakebase()],
});

const result = await AppKit.lakebase.query("SELECT * FROM users WHERE id = $1", [userId]);
```

## Extends

- [`Plugin`](Class.Plugin.md)

## Constructors

### Constructor

```ts
new LakebasePlugin(config: ILakebaseConfig): LakebasePlugin;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | `ILakebaseConfig` |

#### Returns

`LakebasePlugin`

#### Overrides

[`Plugin`](Class.Plugin.md).[`constructor`](Class.Plugin.md#constructor)

## Properties

### app

```ts
protected app: AppManager;
```

#### Inherited from

[`Plugin`](Class.Plugin.md).[`app`](Class.Plugin.md#app)

***

### cache

```ts
protected cache: CacheManager;
```

#### Inherited from

[`Plugin`](Class.Plugin.md).[`cache`](Class.Plugin.md#cache)

***

### config

```ts
protected config: ILakebaseConfig;
```

#### Overrides

[`Plugin`](Class.Plugin.md).[`config`](Class.Plugin.md#config)

***

### devFileReader

```ts
protected devFileReader: DevFileReader;
```

#### Inherited from

[`Plugin`](Class.Plugin.md).[`devFileReader`](Class.Plugin.md#devfilereader)

***

### isReady

```ts
protected isReady: boolean = false;
```

#### Inherited from

[`Plugin`](Class.Plugin.md).[`isReady`](Class.Plugin.md#isready)

***

### name

```ts
name: string = "lakebase";
```

Plugin name identifier.

#### Overrides

[`Plugin`](Class.Plugin.md).[`name`](Class.Plugin.md#name)

***

### streamManager

```ts
protected streamManager: StreamManager;
```

#### Inherited from

[`Plugin`](Class.Plugin.md).[`streamManager`](Class.Plugin.md#streammanager)

***

### telemetry

```ts
protected telemetry: ITelemetry;
```

#### Inherited from

[`Plugin`](Class.Plugin.md).[`telemetry`](Class.Plugin.md#telemetry)

***

### manifest

```ts
static manifest: PluginManifest = lakebaseManifest;
```

Plugin manifest declaring metadata and resource requirements

***

### phase

```ts
static phase: PluginPhase = "normal";
```

Plugin initialization phase.
- 'core': Initialized first (e.g., config plugins)
- 'normal': Initialized second (most plugins)
- 'deferred': Initialized last (e.g., server plugin)

#### Inherited from

[`Plugin`](Class.Plugin.md).[`phase`](Class.Plugin.md#phase)

## Methods

### abortActiveOperations()

```ts
abortActiveOperations(): void;
```

Gracefully drains and closes the connection pool.
Called automatically by AppKit during shutdown.

#### Returns

`void`

#### Overrides

[`Plugin`](Class.Plugin.md).[`abortActiveOperations`](Class.Plugin.md#abortactiveoperations)

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

Error if user token is not available in request headers

#### Inherited from

[`Plugin`](Class.Plugin.md).[`asUser`](Class.Plugin.md#asuser)

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

#### Inherited from

[`Plugin`](Class.Plugin.md).[`execute`](Class.Plugin.md#execute)

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

#### Inherited from

[`Plugin`](Class.Plugin.md).[`executeStream`](Class.Plugin.md#executestream)

***

### exports()

```ts
exports(): {
  getOrmConfig: () => {
     password: string | () => string | () => Promise<string> | undefined;
     ssl:   | boolean
        | {
        rejectUnauthorized: boolean | undefined;
      };
     username: string | undefined;
  };
  getPgConfig: () => PoolConfig;
  pool: Pool;
  query: <T>(text: string, values?: unknown[]) => Promise<QueryResult<T>>;
};
```

Returns the plugin's public API, accessible via `AppKit.lakebase`.

- `pool` — The raw `pg.Pool` instance, for use with ORMs or advanced scenarios
- `query` — Convenience method for executing parameterized SQL queries
- `getOrmConfig()` — Returns a config object compatible with Drizzle, TypeORM, Sequelize, etc.
- `getPgConfig()` — Returns a `pg.PoolConfig` object for manual pool construction

#### Returns

##### getOrmConfig()

```ts
getOrmConfig: () => {
  password: string | () => string | () => Promise<string> | undefined;
  ssl:   | boolean
     | {
     rejectUnauthorized: boolean | undefined;
   };
  username: string | undefined;
};
```

###### Returns

```ts
{
  password: string | () => string | () => Promise<string> | undefined;
  ssl:   | boolean
     | {
     rejectUnauthorized: boolean | undefined;
   };
  username: string | undefined;
}
```

###### password

```ts
password: string | () => string | () => Promise<string> | undefined;
```

###### ssl

```ts
ssl: 
  | boolean
  | {
  rejectUnauthorized: boolean | undefined;
};
```

###### username

```ts
username: string | undefined = user;
```

##### getPgConfig()

```ts
getPgConfig: () => PoolConfig;
```

###### Returns

`PoolConfig`

##### pool

```ts
pool: Pool;
```

##### query()

```ts
query: <T>(text: string, values?: unknown[]) => Promise<QueryResult<T>>;
```

Executes a parameterized SQL query against the Lakebase pool.

###### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` *extends* `QueryResultRow` | `any` |

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `text` | `string` | SQL query string, using `$1`, `$2`, ... placeholders |
| `values?` | `unknown`[] | Parameter values corresponding to placeholders |

###### Returns

`Promise`\<`QueryResult`\<`T`\>\>

Query result with typed rows

###### Throws

If the pool has not been initialized (i.e. `setup()` was not called)

###### Example

```ts
const result = await AppKit.lakebase.query<{ id: number; name: string }>(
  "SELECT id, name FROM users WHERE active = $1",
  [true],
);
```

#### Overrides

[`Plugin`](Class.Plugin.md).[`exports`](Class.Plugin.md#exports)

***

### getEndpoints()

```ts
getEndpoints(): PluginEndpointMap;
```

#### Returns

`PluginEndpointMap`

#### Inherited from

[`Plugin`](Class.Plugin.md).[`getEndpoints`](Class.Plugin.md#getendpoints)

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

#### Inherited from

[`Plugin`](Class.Plugin.md).[`injectRoutes`](Class.Plugin.md#injectroutes)

***

### query()

```ts
query<T>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
```

Executes a parameterized SQL query against the Lakebase pool.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` *extends* `QueryResultRow` | `any` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `text` | `string` | SQL query string, using `$1`, `$2`, ... placeholders |
| `values?` | `unknown`[] | Parameter values corresponding to placeholders |

#### Returns

`Promise`\<`QueryResult`\<`T`\>\>

Query result with typed rows

#### Throws

If the pool has not been initialized (i.e. `setup()` was not called)

#### Example

```ts
const result = await AppKit.lakebase.query<{ id: number; name: string }>(
  "SELECT id, name FROM users WHERE active = $1",
  [true],
);
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

#### Inherited from

[`Plugin`](Class.Plugin.md).[`registerEndpoint`](Class.Plugin.md#registerendpoint)

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

#### Inherited from

[`Plugin`](Class.Plugin.md).[`route`](Class.Plugin.md#route)

***

### setup()

```ts
setup(): Promise<void>;
```

Initializes the Lakebase connection pool.
Called automatically by AppKit during the plugin setup phase.

Resolves the PostgreSQL username via [getUsernameWithApiLookup](Function.getUsernameWithApiLookup.md),
which tries config, env vars, and finally the Databricks workspace API.

#### Returns

`Promise`\<`void`\>

#### Overrides

[`Plugin`](Class.Plugin.md).[`setup`](Class.Plugin.md#setup)
