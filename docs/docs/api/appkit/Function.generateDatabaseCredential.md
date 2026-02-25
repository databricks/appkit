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
// Use the `name` field from the Databricks CLI output:
// `databricks postgres list-endpoints projects/{project-id}/branches/{branch-id}`
const credential = await generateDatabaseCredential(workspaceClient, {
  endpoint: "projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-identifier}"
});

// Use credential.token as password
const conn = await pg.connect({
  host: "ep-abc123.database.us-east-1.databricks.com",
  user: "user@example.com",
  password: credential.token
});
```

```typescript
// Use the `name` field from the Databricks CLI output:
// `databricks postgres list-endpoints projects/{project-id}/branches/{branch-id}`
const credential = await generateDatabaseCredential(workspaceClient, {
  endpoint: "projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-identifier}",
  claims: [{
    permission_set: RequestedClaimsPermissionSet.READ_ONLY,
    resources: [{ table_name: "catalog.schema.users" }]
  }]
});
```
