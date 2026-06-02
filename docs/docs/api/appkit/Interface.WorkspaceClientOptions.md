# Interface: WorkspaceClientOptions

Options used to construct the wrapper. Mirrors the subset of the old SDK's
`Config` + `ClientOptions` that AppKit relies on today; we explicitly do
NOT re-expose every old-SDK config knob.

## Properties

### authType?

```ts
optional authType: "pat";
```

Authentication strategy passed to the legacy client.

***

### host?

```ts
optional host: string;
```

Databricks host, e.g. https://my-workspace.cloud.databricks.com. Defaults to DATABRICKS_HOST.

***

### product

```ts
product: string;
```

Product name used in the User-Agent (e.g. "@databricks/appkit").

***

### productVersion

```ts
productVersion: `${number}.${number}.${number}`;
```

Product version (semver) used in the User-Agent.

***

### token?

```ts
optional token: string;
```

Bearer token. When set, `authType` is forced to "pat".

***

### userAgentExtra?

```ts
optional userAgentExtra: Record<string, string>;
```

Additional User-Agent segments.
