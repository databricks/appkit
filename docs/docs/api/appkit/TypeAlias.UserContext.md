# ~~Type Alias: UserContext~~

```ts
type UserContext = {
  client: ServiceContextState["client"];
  isUserContext: true;
  tokenFingerprint?: string;
  userEmail?: string;
  userId: string;
  userName?: string;
  warehouseId?: Promise<string>;
  workspaceId: Promise<string>;
};
```

## Deprecated

Use CallerContext and its principal field. Kept for callers
that construct the legacy shape or read its flat identity fields.

## Properties

### ~~client~~

```ts
client: ServiceContextState["client"];
```

WorkspaceClient authenticated as the user

***

### ~~isUserContext~~

```ts
isUserContext: true;
```

Flag indicating this is a user context

***

### ~~tokenFingerprint?~~

```ts
optional tokenFingerprint: string;
```

Truncated SHA-256 hash of the user's OBO token, used to detect token rotation

***

### ~~userEmail?~~

```ts
optional userEmail: string;
```

The user's email (from `x-forwarded-email` header)

***

### ~~userId~~

```ts
userId: string;
```

The user's ID (from request headers)

***

### ~~userName?~~

```ts
optional userName: string;
```

The user's name (from request headers)

***

### ~~warehouseId?~~

```ts
optional warehouseId: Promise<string>;
```

#### Deprecated

Use getWarehouseId() from @databricks/appkit.

***

### ~~workspaceId~~

```ts
workspaceId: Promise<string>;
```

Promise that resolves to the workspace ID (inherited from service context)
