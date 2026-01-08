# Class: ServiceContext

Defined in: [appkit/src/context/service-context.ts:48](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/service-context.ts#L48)

ServiceContext is a singleton that manages the service principal's
WorkspaceClient and shared resources like warehouse/workspace IDs.

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

### createUserContext()

```ts
static createUserContext(
   token: string, 
   userId: string, 
   userName?: string): UserContext;
```

Defined in: [appkit/src/context/service-context.ts:98](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/service-context.ts#L98)

Create a user context from request headers.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `token` | `string` | The user's access token from x-forwarded-access-token header |
| `userId` | `string` | The user's ID from x-forwarded-user header |
| `userName?` | `string` | Optional user name |

#### Returns

[`UserContext`](Interface.UserContext.md)

#### Throws

Error if token is not provided

***

### get()

```ts
static get(): ServiceContextState;
```

Defined in: [appkit/src/context/service-context.ts:74](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/service-context.ts#L74)

Get the initialized service context.

#### Returns

[`ServiceContextState`](Interface.ServiceContextState.md)

#### Throws

Error if not initialized

***

### getClientOptions()

```ts
static getClientOptions(): ClientOptions;
```

Defined in: [appkit/src/context/service-context.ts:142](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/service-context.ts#L142)

Get the client options for WorkspaceClient.
Exposed for testing purposes.

#### Returns

`ClientOptions`

***

### initialize()

```ts
static initialize(): Promise<ServiceContextState>;
```

Defined in: [appkit/src/context/service-context.ts:56](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/service-context.ts#L56)

Initialize the service context. Should be called once at app startup.
Safe to call multiple times - will return the same instance.

#### Returns

`Promise`\<[`ServiceContextState`](Interface.ServiceContextState.md)\>

***

### isInitialized()

```ts
static isInitialized(): boolean;
```

Defined in: [appkit/src/context/service-context.ts:86](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/service-context.ts#L86)

Check if the service context has been initialized.

#### Returns

`boolean`

***

### reset()

```ts
static reset(): void;
```

Defined in: [appkit/src/context/service-context.ts:249](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/service-context.ts#L249)

Reset the service context. Only for testing purposes.

#### Returns

`void`
