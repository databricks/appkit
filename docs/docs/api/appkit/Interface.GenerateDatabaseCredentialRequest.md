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

Endpoint resource path. Retrieve using the Databricks CLI:
```
databricks postgres list-endpoints projects/{project-id}/branches/{branch-id}
```
Use the `name` field from the output.

#### Example

```ts
"projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-identifier}"
```
