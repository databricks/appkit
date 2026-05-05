# Type Alias: JobHandle

```ts
type JobHandle = JobAPI & {
  asUser: (req: IAppRequest) => JobAPI;
};
```

Job handle returned by `appkit.jobs("etl")`.
Supports OBO access via `.asUser(req)`.

## Type Declaration

### asUser()

```ts
asUser: (req: IAppRequest) => JobAPI;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `req` | `IAppRequest` |

#### Returns

[`JobAPI`](Interface.JobAPI.md)
