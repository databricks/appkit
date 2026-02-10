# Function: generateDatabaseCredential()

```ts
function generateDatabaseCredential(workspaceClient: WorkspaceClient, request: GenerateDatabaseCredentialRequest): Promise<DatabaseCredential>;
```

Generate OAuth credentials for Postgres database connection using the proper Postgres API.

This generates a time-limited OAuth token (expires after 1 hour) that can be used
as a password when connecting to Lakebase Postgres databases.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `workspaceClient` | `WorkspaceClient` | Databricks workspace client for authentication |
| `request` | [`GenerateDatabaseCredentialRequest`](Interface.GenerateDatabaseCredentialRequest.md) | Request parameters including endpoint path and optional UC claims |

## Returns

`Promise`\<[`DatabaseCredential`](Interface.DatabaseCredential.md)\>

Database credentials with OAuth token and expiration time

## See

https://docs.databricks.com/aws/en/oltp/projects/authentication

## Examples

```typescript
// Format: projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-id}
// Note: Use actual IDs from Databricks (project-id is a UUID)
const credential = await generateDatabaseCredential(workspaceClient, {
  endpoint: "projects/6bef4151-4b5d-4147-b4d0-c2f4fd5b40db/branches/br-sparkling-tree-y17uj7fn/endpoints/ep-restless-pine-y1ldaht0"
});

// Use credential.token as password
const conn = await pg.connect({
  host: "ep-abc123.database.us-east-1.databricks.com",
  user: "user@example.com",
  password: credential.token
});
```

```typescript
// Format: projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-id}
const credential = await generateDatabaseCredential(workspaceClient, {
  endpoint: "projects/6bef4151-4b5d-4147-b4d0-c2f4fd5b40db/branches/br-sparkling-tree-y17uj7fn/endpoints/ep-restless-pine-y1ldaht0",
  claims: [{
    permission_set: RequestedClaimsPermissionSet.READ_ONLY,
    resources: [{ table_name: "catalog.schema.users" }]
  }]
});
```
