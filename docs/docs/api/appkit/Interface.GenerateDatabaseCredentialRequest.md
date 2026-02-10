# Interface: GenerateDatabaseCredentialRequest

Request parameters for generating database OAuth credentials

## Properties

### claims?

```ts
optional claims: RequestedClaims[];
```

Optional claims for fine-grained UC table permissions.
When specified, the token will only grant access to the specified tables.

#### Example

```typescript
{
  claims: [{
    permission_set: RequestedClaimsPermissionSet.READ_ONLY,
    resources: [{ table_name: "catalog.schema.users" }]
  }]
}
```

***

### endpoint

```ts
endpoint: string;
```

Endpoint resource path with IDs assigned by Databricks.

All segments are IDs from Databricks (not names you create):
- project-id: UUID format (e.g., `a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789`)
- branch-id: Identifier from Databricks (e.g., `main`, `dev`)
- endpoint-id: Identifier from Databricks (e.g., `primary`, `analytics`)

Format: `projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-id}`

**Important:** Copy from Databricks Lakebase UI - do not construct manually.

#### Example

```ts
"projects/6bef4151-4b5d-4147-b4d0-c2f4fd5b40db/branches/br-sparkling-tree-y17uj7fn/endpoints/ep-restless-pine-y1ldaht0"
```
