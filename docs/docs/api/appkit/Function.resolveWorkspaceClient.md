# Function: resolveWorkspaceClient()

```ts
function resolveWorkspaceClient(options: ResolveDatabricksAuthOptions): WorkspaceClient | undefined;
```

Construct a Databricks `WorkspaceClient` for the eval runner — the object the
SDK-backed connectors (e.g. `SQLWarehouseConnector`) take. An explicit
host+token builds a PAT client; otherwise the profile (or ambient config) is
used and the SDK resolves credentials, minting OAuth as needed. Returns
`undefined` if construction throws (missing/invalid config).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`ResolveDatabricksAuthOptions`](Interface.ResolveDatabricksAuthOptions.md) |

## Returns

[`WorkspaceClient`](Interface.WorkspaceClient.md) \| `undefined`
