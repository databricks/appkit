# Interface: SupervisorApiAdapterOptions

## Properties

### model

```ts
model: string;
```

Model identifier to pass in the request body
(e.g. "databricks-claude-sonnet-4").

***

### timeoutMs?

```ts
optional timeoutMs: number;
```

Total wall-clock budget (ms) for a single `run()`. When the SSE stream
runs longer than this — e.g. an upstream that stalls without closing —
the adapter aborts it and emits a terminal `transport` error rather than
hanging the request indefinitely.

This is a total-duration cap, not an idle cap. Defaults to 5 minutes,
generous enough for multi-tool server-side orchestration.

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
