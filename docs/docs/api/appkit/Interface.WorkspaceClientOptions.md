# Interface: WorkspaceClientOptions

Options used to construct the wrapper. Mirrors the subset of the old SDK's
`Config` + `ClientOptions` that AppKit relies on today; we deliberately do
NOT re-expose every old-SDK config knob.

## Properties

### authType?

```ts
optional authType: "pat";
```

Authentication strategy passed to the legacy client.

***

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

Bearer token. When set, `authType` defaults to "pat".
