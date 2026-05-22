# Interface: SupervisorApiAdapterOptions

## Properties

### model

```ts
model: string;
```

Model identifier to pass in the request body
(e.g. "databricks-claude-sonnet-4").

***

### workspaceClient?

```ts
optional workspaceClient: WorkspaceClientLike;
```

A WorkspaceClient (or structural equivalent) used for host resolution
and per-request authentication. When omitted, a `WorkspaceClient({})`
is created internally using the default SDK credential chain
(`DATABRICKS_HOST`, OAuth, PAT, etc.).

⚠ The `workspaceClient` is captured at construction and reused across
every request. Passing a per-request OBO (On-Behalf-Of) client here
would silently leak the first request's identity into all subsequent
requests served by this adapter instance. Use the default credential
chain or pass a service-principal client. (CWE-664)
