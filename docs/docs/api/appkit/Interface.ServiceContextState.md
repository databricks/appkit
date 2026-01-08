# Interface: ServiceContextState

Defined in: [appkit/src/context/service-context.ts:17](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/service-context.ts#L17)

Service context holds the service principal client and shared resources.
This is initialized once at app startup and shared across all requests.

## Properties

### client

```ts
client: WorkspaceClient;
```

Defined in: [appkit/src/context/service-context.ts:19](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/service-context.ts#L19)

WorkspaceClient authenticated as the service principal

***

### serviceUserId

```ts
serviceUserId: string;
```

Defined in: [appkit/src/context/service-context.ts:21](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/service-context.ts#L21)

The service principal's user ID

***

### warehouseId

```ts
warehouseId: Promise<string>;
```

Defined in: [appkit/src/context/service-context.ts:23](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/service-context.ts#L23)

Promise that resolves to the warehouse ID

***

### workspaceId

```ts
workspaceId: Promise<string>;
```

Defined in: [appkit/src/context/service-context.ts:25](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/service-context.ts#L25)

Promise that resolves to the workspace ID
