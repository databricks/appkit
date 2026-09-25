# Class: ServiceContext

ServiceContext is a singleton that manages the service principal's
WorkspaceClient and workspace ID. WarehouseResource owns warehouse bindings.

It's initialized once at app startup and provides the foundation
for both service principal and user context execution.

## Constructors

### Constructor

```ts
new ServiceContext(): ServiceContext;
```

#### Returns

`ServiceContext`

## Methods

### createCallerContext()

```ts
static createCallerContext(
   token: string, 
   userId: string, 
   userName?: string, 
   userEmail?: string): CallerContext;
```

Create an immutable caller context from the existing user request headers.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `token` | `string` | The user's access token from x-forwarded-access-token header |
| `userId` | `string` | The user's ID from x-forwarded-user header |
| `userName?` | `string` | Optional user name |
| `userEmail?` | `string` | Optional email from x-forwarded-email |

#### Returns

[`CallerContext`](Interface.CallerContext.md)

#### Throws

Error if token is not provided

***

### ~~createUserContext()~~

```ts
static createUserContext(
   token: string, 
   userId: string, 
   userName?: string, 
   userEmail?: string): CallerContext & UserContext;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `token` | `string` |
| `userId` | `string` |
| `userName?` | `string` |
| `userEmail?` | `string` |

#### Returns

[`CallerContext`](Interface.CallerContext.md) & [`UserContext`](TypeAlias.UserContext.md)

#### Deprecated

Use ServiceContext.createCallerContext.

***

### get()

```ts
static get(): ServiceContextState;
```

Get the initialized service context.

#### Returns

`ServiceContextState`

#### Throws

Error if not initialized

***

### getClientOptions()

```ts
static getClientOptions(): ClientOptions;
```

Get the client options for WorkspaceClient.
Exposed for testing purposes.

#### Returns

`ClientOptions`

***

### initialize()

```ts
static initialize(options?: {
  warehouseId?: boolean;
}, client?: WorkspaceClient): Promise<ServiceContextState>;
```

Initialize the service context. Should be called once at app startup.
Safe to call multiple times - will return the same instance.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | \{ `warehouseId?`: `boolean`; \} | Which shared resources to resolve (derived from plugin manifests). |
| `options.warehouseId?` | `boolean` | - |
| `client?` | [`WorkspaceClient`](Interface.WorkspaceClient.md) | Optional pre-configured WorkspaceClient to use instead of creating one from environment credentials. |

#### Returns

`Promise`\<`ServiceContextState`\>

***

### isInitialized()

```ts
static isInitialized(): boolean;
```

Check if the service context has been initialized.

#### Returns

`boolean`

***

### reset()

```ts
static reset(): void;
```

Reset the service context. Only for testing purposes.

#### Returns

`void`
