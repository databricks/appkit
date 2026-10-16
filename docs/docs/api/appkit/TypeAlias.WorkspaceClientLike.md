# Type Alias: WorkspaceClientLike

```ts
type WorkspaceClientLike = 
  | WorkspaceRequestClientLike
  | ApiClientLike & {
  config: {
     ensureResolved: Promise<void>;
  };
};
```

Structural shape of a Databricks SDK client used by [fromSupervisorApi](Function.fromSupervisorApi.md).
Only what we need: `request` for streaming. A legacy SDK client
(`apiClient.request` + `config.ensureResolved`) is still accepted (deprecated).

Exported because [SupervisorApiAdapterOptions.workspaceClient](Interface.SupervisorApiAdapterOptions.md#workspaceclient) (a
public type) references it — callers passing their own client can name
the shape they need to satisfy.
