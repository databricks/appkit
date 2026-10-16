# Interface: WorkspaceClient

AppKit's workspace client facade. Mirrors the multi-client shape of the
modular Databricks SDK: each service is its own accessor, so services can be
migrated one at a time behind this stable interface.

## Extends

- `WorkspaceAuth`

## Properties

### apps

```ts
readonly apps: AppsClient;
```

Databricks Apps (modular SDK).

***

### connections

```ts
readonly connections: ConnectionsClient;
```

Unity Catalog Connections (modular SDK).

***

### currentUser

```ts
readonly currentUser: ScimClient;
```

Current user (modular SDK SCIM client; `me({})` returns the caller).

***

### database

```ts
readonly database: DatabaseClient;
```

Lakebase provisioned database instances + credentials (modular SDK).

***

### experiments

```ts
readonly experiments: ExperimentsClient;
```

MLflow Experiments (modular SDK).

***

### files

```ts
readonly files: FilesClient;
```

UC Volumes / Files API (modular SDK).

***

### functions

```ts
readonly functions: FunctionsClient;
```

Unity Catalog Functions (modular SDK).

***

### genie

```ts
readonly genie: GenieClient;
```

Genie (modular SDK).

***

### jobs

```ts
readonly jobs: JobsClient;
```

Jobs (modular SDK, Jobs API 2.2).

***

### modelServing

```ts
readonly modelServing: ModelServingClient;
```

Serving endpoints (modular SDK).

***

### postgres

```ts
readonly postgres: PostgresClient;
```

Lakebase Postgres: autoscaling projects, branches, endpoints (modular SDK).

***

### statementExecution

```ts
readonly statementExecution: StatementExecutionClient;
```

Statement Execution (modular SDK).

***

### tables

```ts
readonly tables: TablesClient;
```

Unity Catalog Tables (modular SDK).

***

### vectorSearch

```ts
readonly vectorSearch: VectorSearchClient;
```

Vector Search (modular SDK; index metadata only, queries use `request()`).

***

### volumes

```ts
readonly volumes: VolumesClient;
```

Unity Catalog Volumes (modular SDK).

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
[ApiError](Class.ApiError.md) on a non-2xx status.

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
