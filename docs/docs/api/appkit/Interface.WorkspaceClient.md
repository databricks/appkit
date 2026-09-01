# Interface: WorkspaceClient

AppKit's workspace client facade. Mirrors the multi-client shape of the
modular Databricks SDK: each service is its own accessor, so services can be
migrated one at a time behind this stable interface.

Accessors are legacy-typed for now (delegated to the underlying legacy SDK
client); see the module docblock.

## Properties

### apiClient

```ts
readonly apiClient: ApiClient;
```

Low-level HTTP transport (`apiClient.request(...)`). Used for endpoints
without a typed service method: SCIM header probe, warehouse listing,
serving SSE streaming, vector search, internal telemetry.

***

### config

```ts
readonly config: Config;
```

SDK `Config` — exposes `host` and `authenticate(headers)`. Used by the
files-upload path and agents auth-header stamping, which bypass the typed
services.

***

### currentUser

```ts
readonly currentUser: CurrentUserService;
```

Current user.

***

### files

```ts
readonly files: FilesService;
```

UC Volumes / Files API.

***

### genie

```ts
readonly genie: GenieService;
```

Genie / dashboards.

***

### jobs

```ts
readonly jobs: JobsService;
```

Jobs.

***

### servingEndpoints

```ts
readonly servingEndpoints: ServingEndpointsService;
```

Serving Endpoints.

***

### statementExecution

```ts
readonly statementExecution: StatementExecutionClient;
```

Statement Execution (modular SDK).

***

### warehouses

```ts
readonly warehouses: WarehousesClient;
```

SQL Warehouses (modular SDK).

## Methods

### toLegacyWorkspaceClient()

```ts
toLegacyWorkspaceClient(): WorkspaceClient;
```

Returns the underlying legacy `@databricks/sdk-experimental`
`WorkspaceClient`, for handoff to code still typed against the old SDK
(`@databricks/lakebase`). Transitional.

#### Returns

`WorkspaceClient`
