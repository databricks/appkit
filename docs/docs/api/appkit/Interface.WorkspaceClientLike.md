# Interface: WorkspaceClientLike

Structural shape of a Databricks SDK client used by [fromSupervisorApi](Function.fromSupervisorApi.md).
Only what we need: `apiClient.request` for streaming and
`config.ensureResolved` to materialise the host/credentials.

Exported because [SupervisorApiAdapterOptions.workspaceClient](Interface.SupervisorApiAdapterOptions.md#workspaceclient) (a
public type) references it — callers passing their own client can name
the shape they need to satisfy.

## Extends

- `ApiClientLike`

## Properties

### apiClient

```ts
apiClient: {
  request: Promise<unknown>;
};
```

#### request()

```ts
request(options: Record<string, unknown>, context?: unknown): Promise<unknown>;
```

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | `Record`\<`string`, `unknown`\> |
| `context?` | `unknown` |

##### Returns

`Promise`\<`unknown`\>

#### Inherited from

```ts
ApiClientLike.apiClient
```

***

### config

```ts
config: {
  ensureResolved: Promise<void>;
};
```

#### ensureResolved()

```ts
ensureResolved(): Promise<void>;
```

##### Returns

`Promise`\<`void`\>
