# Function: createWorkspaceClient()

```ts
function createWorkspaceClient(opts: WorkspaceClientOptions): WorkspaceClient;
```

Construct an AppKit workspace client.

Auth resolution:
  - If `opts.token` is set, uses PAT credentials.
  - Otherwise, walks the SDK default auth chain (env vars +
    ~/.databrickscfg).

Host resolution:
  - Explicit `opts.host` → use it.
  - Otherwise `DATABRICKS_HOST` env var.
  - Otherwise the legacy client's resolved host (lazy fallback).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`WorkspaceClientOptions`](Interface.WorkspaceClientOptions.md) |

## Returns

[`WorkspaceClient`](Interface.WorkspaceClient.md)
