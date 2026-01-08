# Interface: UserContext

Defined in: [appkit/src/context/user-context.ts:7](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/user-context.ts#L7)

User execution context extends the service context with user-specific data.
Created on-demand when asUser(req) is called.

## Properties

### client

```ts
client: WorkspaceClient;
```

Defined in: [appkit/src/context/user-context.ts:9](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/user-context.ts#L9)

WorkspaceClient authenticated as the user

***

### isUserContext

```ts
isUserContext: true;
```

Defined in: [appkit/src/context/user-context.ts:19](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/user-context.ts#L19)

Flag indicating this is a user context

***

### userId

```ts
userId: string;
```

Defined in: [appkit/src/context/user-context.ts:11](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/user-context.ts#L11)

The user's ID (from request headers)

***

### userName?

```ts
optional userName: string;
```

Defined in: [appkit/src/context/user-context.ts:13](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/user-context.ts#L13)

The user's name (from request headers)

***

### warehouseId

```ts
warehouseId: Promise<string>;
```

Defined in: [appkit/src/context/user-context.ts:15](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/user-context.ts#L15)

Promise that resolves to the warehouse ID (inherited from service context)

***

### workspaceId

```ts
workspaceId: Promise<string>;
```

Defined in: [appkit/src/context/user-context.ts:17](https://github.com/databricks/appkit/blob/main/packages/appkit/src/context/user-context.ts#L17)

Promise that resolves to the workspace ID (inherited from service context)
