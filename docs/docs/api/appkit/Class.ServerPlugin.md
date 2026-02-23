# Class: ServerPlugin

Server plugin for the AppKit.

This plugin is responsible for starting the server and serving the static files.
It also handles the remote tunneling for development purposes.

## Example

```ts
createApp({
  plugins: [server(), telemetryExamples(), analytics({})],
});
```

## Extends

- [`Plugin`](Class.Plugin.md)

## Constructors

### Constructor

```ts
new ServerPlugin(config: ServerConfig): ServerPlugin;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | `ServerConfig` |

#### Returns

`ServerPlugin`

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
protected config: ServerConfig;
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
name: "server";
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

### DEFAULT\_CONFIG

```ts
static DEFAULT_CONFIG: {
  autoStart: boolean;
  host: string;
  port: number;
};
```

#### autoStart

```ts
autoStart: boolean = true;
```

#### host

```ts
host: string;
```

#### port

```ts
port: number;
```

***

### manifest

```ts
static manifest: PluginManifest = serverManifest;
```

Plugin manifest declaring metadata and resource requirements

***

### phase

```ts
static phase: PluginPhase = "deferred";
```

Plugin initialization phase.
- 'core': Initialized first (e.g., config plugins)
- 'normal': Initialized second (most plugins)
- 'deferred': Initialized last (e.g., server plugin)

#### Overrides

[`Plugin`](Class.Plugin.md).[`phase`](Class.Plugin.md#phase)

## Methods

### abortActiveOperations()

```ts
abortActiveOperations(): void;
```

#### Returns

`void`

#### Inherited from

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
  getConfig: () => {
   [key: string]: unknown;
     autoStart?: boolean;
     host?: string;
     name?: string;
     port?: number;
     staticPath?: string;
     telemetry?: TelemetryOptions;
  };
  getServer: () => Server;
  start: () => Promise<Application>;
  extend: { start: () => Promise<Application>; extend(fn: (app: Application) => void): ...; getServer: () => Server<typeof IncomingMessage, typeof ServerResponse>; getConfig: () => { ...; }; };
};
```

Returns the public exports for the server plugin.
Exposes server management methods.

#### Returns

##### getConfig()

```ts
getConfig: () => {
[key: string]: unknown;
  autoStart?: boolean;
  host?: string;
  name?: string;
  port?: number;
  staticPath?: string;
  telemetry?: TelemetryOptions;
};
```

Get the server configuration

Get the server configuration.

###### Returns

```ts
{
[key: string]: unknown;
  autoStart?: boolean;
  host?: string;
  name?: string;
  port?: number;
  staticPath?: string;
  telemetry?: TelemetryOptions;
}
```

###### autoStart?

```ts
optional autoStart: boolean;
```

###### host?

```ts
optional host: string;
```

###### name?

```ts
optional name: string;
```

###### port?

```ts
optional port: number;
```

###### staticPath?

```ts
optional staticPath: string;
```

###### telemetry?

```ts
optional telemetry: TelemetryOptions;
```

##### getServer()

```ts
getServer: () => Server;
```

Get the underlying HTTP server instance

Get the low level node.js http server instance.

Only use this method if you need to access the server instance for advanced usage like a custom websocket server, etc.

###### Returns

`Server`

The server instance.

###### Throws

If the server is not started or autoStart is true.

##### start()

```ts
start: () => Promise<Application>;
```

Start the server

Start the server.

This method starts the server and sets up the frontend.
It also sets up the remote tunneling if enabled.

###### Returns

`Promise`\<`Application`\>

The express application.

##### extend()

```ts
extend(fn: (app: Application) => void): { start: () => Promise<Application>; extend(fn: (app: Application) => void): ...; getServer: () => Server<typeof IncomingMessage, typeof ServerResponse>; getConfig: () => { ...; }; };
```

Extend the server with custom routes or middleware

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `fn` | (`app`: `Application`) => `void` |

###### Returns

\{ start: () =\> Promise\<Application\>; extend(fn: (app: Application) =\> void): ...; getServer: () =\> Server\<typeof IncomingMessage, typeof ServerResponse\>; getConfig: () =\> \{ ...; \}; \}

#### Overrides

[`Plugin`](Class.Plugin.md).[`exports`](Class.Plugin.md#exports)

***

### extend()

```ts
extend(fn: (app: Application) => void): ServerPlugin;
```

Extend the server with custom routes or middleware.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `fn` | (`app`: `Application`) => `void` | A function that receives the express application. |

#### Returns

`ServerPlugin`

The server plugin instance for chaining.

#### Throws

If autoStart is true.

***

### getConfig()

```ts
getConfig(): {
[key: string]: unknown;
  autoStart?: boolean;
  host?: string;
  name?: string;
  port?: number;
  staticPath?: string;
  telemetry?: TelemetryOptions;
};
```

Get the server configuration.

#### Returns

```ts
{
[key: string]: unknown;
  autoStart?: boolean;
  host?: string;
  name?: string;
  port?: number;
  staticPath?: string;
  telemetry?: TelemetryOptions;
}
```

##### autoStart?

```ts
optional autoStart: boolean;
```

##### host?

```ts
optional host: string;
```

##### name?

```ts
optional name: string;
```

##### port?

```ts
optional port: number;
```

##### staticPath?

```ts
optional staticPath: string;
```

##### telemetry?

```ts
optional telemetry: TelemetryOptions;
```

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

### getServer()

```ts
getServer(): Server;
```

Get the low level node.js http server instance.

Only use this method if you need to access the server instance for advanced usage like a custom websocket server, etc.

#### Returns

`Server`

The server instance.

#### Throws

If the server is not started or autoStart is true.

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

Setup the server plugin.

#### Returns

`Promise`\<`void`\>

#### Overrides

[`Plugin`](Class.Plugin.md).[`setup`](Class.Plugin.md#setup)

***

### shouldAutoStart()

```ts
shouldAutoStart(): boolean | undefined;
```

Check if the server should auto start.

#### Returns

`boolean` \| `undefined`

***

### start()

```ts
start(): Promise<Application>;
```

Start the server.

This method starts the server and sets up the frontend.
It also sets up the remote tunneling if enabled.

#### Returns

`Promise`\<`Application`\>

The express application.
