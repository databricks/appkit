# Interface: WorkspaceClient

AppKit's workspace client facade. Mirrors the multi-client shape of the
modular Databricks SDK: each service is its own accessor, so services can be
migrated one at a time behind this stable interface.

Accessors are legacy-typed for now (delegated to the underlying legacy SDK
client); see the module docblock.

## Extends

- `WorkspaceAuth`

## Properties

### apiClient

```ts
readonly apiClient: ApiClient;
```

Legacy low-level HTTP transport. Prefer `request(...)` (modular, inherited
from `WorkspaceAuth`); still used by serving SSE streaming, vector search,
and the agents adapters, which take a structural `apiClient` shape.

***

### config

```ts
readonly config: Config;
```

Legacy SDK `Config`. Prefer `getHost()` / `authenticate(headers)` (modular,
inherited from `WorkspaceAuth`); kept for structural `WorkspaceClientLike`
callers (supervisor adapter) until they migrate.

***

### currentUser

```ts
readonly currentUser: ScimClient;
```

Current user (modular SDK SCIM client; `me({})` returns the caller).

***

### files

```ts
readonly files: FilesService;
```

UC Volumes / Files API.

***

### genie

```ts
readonly genie: GenieClient;
```

Genie (modular SDK).

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

### authenticate()

```ts
authenticate(headers: Headers): Promise<void>;
```

Set the auth header(s) (e.g. `Authorization`) on `headers`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `headers` | `Headers` |

#### Returns

`Promise`\<`void`\>

#### Inherited from

```ts
WorkspaceAuth.authenticate
```

***

### getHost()

```ts
getHost(): Promise<string>;
```

Scheme-normalized workspace host, without a trailing slash.

#### Returns

`Promise`\<`string`\>

#### Inherited from

```ts
WorkspaceAuth.getHost
```

***

### request()

```ts
request(req: WorkspaceRequest): Promise<Response>;
```

Send a request through the modular transport (AppKit User-Agent + auth).
Returns the raw `Response` (body unread, so it can stream); throws
ApiError on a non-2xx status.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `req` | `WorkspaceRequest` |

#### Returns

`Promise`\<`Response`\>

#### Inherited from

```ts
WorkspaceAuth.request
```

***

### toLegacyWorkspaceClient()

```ts
toLegacyWorkspaceClient(): WorkspaceClient;
```

Returns the underlying legacy `@databricks/sdk-experimental`
`WorkspaceClient`, for handoff to code still typed against the old SDK
(`@databricks/lakebase`). Transitional.

#### Returns

`WorkspaceClient`
