# Interface: WorkspaceClient

The wrapper's facade type. Migrated services use modular SDK clients
directly; legacy delegates are explicitly marked.

## Properties

### config

```ts
readonly config: Config;
```

Legacy config (host + authenticate) for the files-upload workaround.
TODO(prod): audit whether modular FilesClient.uploadFile fixes the
upstream upload bugs and drop this property.

***

### currentUser

```ts
readonly currentUser: CurrentUserService;
```

Current user. TODO(prod): migrate to modular IAM package when available.

***

### files

```ts
readonly files: FilesClient;
```

UC Volumes / Files API — `@databricks/sdk-files`.

***

### genie

```ts
readonly genie: GenieService;
```

Genie / dashboards. Delegated to the legacy SDK because the modular
`@databricks/sdk-genie` surface diverges (method renames + waiter
idiom). TODO(prod): rewrite `connectors/genie/client.ts` against the
modular client.

***

### http

```ts
readonly http: AppKitHttpClient;
```

Low-level authenticated HTTP. Replaces the old SDK's
`apiClient.request(...)` for SCIM Me header probe, serving SSE
streaming, and internal telemetry. Native `AbortSignal`.

***

### jobs

```ts
readonly jobs: JobsService;
```

Jobs. Delegated to the legacy SDK because the modular
`@databricks/sdk-jobs` surface diverges (method renames + camelCase
field shapes). TODO(prod): rewrite `connectors/jobs/client.ts`.

***

### servingEndpoints

```ts
readonly servingEndpoints: ServingEndpointsService;
```

Serving Endpoints. TODO(prod): no modular package yet.

***

### statementExecution

```ts
readonly statementExecution: StatementExecutionService;
```

Statement Execution. TODO(prod): no modular package yet.

***

### vectorSearch

```ts
readonly vectorSearch: VectorSearchClient;
```

Vector Search — `@databricks/sdk-vectorsearch`.

***

### warehouses

```ts
readonly warehouses: WarehousesClient;
```

SQL Warehouses — `@databricks/sdk-warehouses`.

## Methods

### toLegacyWorkspaceClient()

```ts
toLegacyWorkspaceClient(): WorkspaceClient;
```

Returns the underlying `@databricks/sdk-experimental` `WorkspaceClient`
for handoff to `@databricks/lakebase` (still typed against the old
SDK). Transitional; removed when lakebase migrates.

#### Returns

`WorkspaceClient`
