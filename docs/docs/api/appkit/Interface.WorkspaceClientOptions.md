# Interface: WorkspaceClientOptions

## Properties

### clientOptions?

```ts
optional clientOptions: ClientOptions;
```

SDK client options (product / productVersion / userAgentExtra) used to
stamp the outbound User-Agent. Produced by `getClientOptions()`; omitted
by build-time callers that don't stamp a User-Agent.

***

### host?

```ts
optional host: string;
```

Databricks host, e.g. https://my-workspace.cloud.databricks.com. Defaults to DATABRICKS_HOST / profile resolution.

***

### profile?

```ts
optional profile: string;
```

`~/.databrickscfg` profile name. Used when no host/token is provided.

***

### token?

```ts
optional token: string;
```

Bearer token (PAT, or the user's OBO token).
