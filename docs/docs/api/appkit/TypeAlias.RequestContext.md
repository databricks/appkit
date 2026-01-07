# Type Alias: RequestContext

```ts
type RequestContext = {
  serviceDatabricksClient: WorkspaceClient;
  serviceUserId: string;
  userDatabricksClient?: WorkspaceClient;
  userId: string;
  userName?: string;
  warehouseId: Promise<string>;
  workspaceId: Promise<string>;
};
```

Defined in: [appkit/src/utils/databricks-client-middleware.ts:13](https://github.com/databricks/appkit/blob/main/packages/appkit/src/utils/databricks-client-middleware.ts#L13)

## Properties

### serviceDatabricksClient

```ts
serviceDatabricksClient: WorkspaceClient;
```

Defined in: [appkit/src/utils/databricks-client-middleware.ts:15](https://github.com/databricks/appkit/blob/main/packages/appkit/src/utils/databricks-client-middleware.ts#L15)

***

### serviceUserId

```ts
serviceUserId: string;
```

Defined in: [appkit/src/utils/databricks-client-middleware.ts:18](https://github.com/databricks/appkit/blob/main/packages/appkit/src/utils/databricks-client-middleware.ts#L18)

***

### userDatabricksClient?

```ts
optional userDatabricksClient: WorkspaceClient;
```

Defined in: [appkit/src/utils/databricks-client-middleware.ts:14](https://github.com/databricks/appkit/blob/main/packages/appkit/src/utils/databricks-client-middleware.ts#L14)

***

### userId

```ts
userId: string;
```

Defined in: [appkit/src/utils/databricks-client-middleware.ts:16](https://github.com/databricks/appkit/blob/main/packages/appkit/src/utils/databricks-client-middleware.ts#L16)

***

### userName?

```ts
optional userName: string;
```

Defined in: [appkit/src/utils/databricks-client-middleware.ts:17](https://github.com/databricks/appkit/blob/main/packages/appkit/src/utils/databricks-client-middleware.ts#L17)

***

### warehouseId

```ts
warehouseId: Promise<string>;
```

Defined in: [appkit/src/utils/databricks-client-middleware.ts:19](https://github.com/databricks/appkit/blob/main/packages/appkit/src/utils/databricks-client-middleware.ts#L19)

***

### workspaceId

```ts
workspaceId: Promise<string>;
```

Defined in: [appkit/src/utils/databricks-client-middleware.ts:20](https://github.com/databricks/appkit/blob/main/packages/appkit/src/utils/databricks-client-middleware.ts#L20)
