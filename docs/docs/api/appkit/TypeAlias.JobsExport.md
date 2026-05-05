# Type Alias: JobsExport()

```ts
type JobsExport = (jobKey: string) => JobHandle;
```

Public API shape of the jobs plugin.
Callable to select a job by key.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `jobKey` | `string` |

## Returns

[`JobHandle`](TypeAlias.JobHandle.md)

## Example

```ts
// Trigger a configured job
const { run_id } = await appkit.jobs("etl").runNow();

// Trigger and poll until completion
for await (const status of appkit.jobs("etl").runAndWait()) {
  console.log(status.status, status.run);
}

// OBO access
await appkit.jobs("etl").asUser(req).runNow();
```
