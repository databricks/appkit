# Type Alias: JobsExport()

```ts
type JobsExport = (jobKey: string) => JobAPI;
```

Public API shape of the jobs plugin.
Callable to select a job by key.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `jobKey` | `string` |

## Returns

[`JobAPI`](Interface.JobAPI.md)

## Example

```ts
// Trigger a configured job
const { run_id } = await appkit.jobs("etl").runNow();

// Trigger and poll until completion
for await (const status of appkit.jobs("etl").runAndWait()) {
  console.log(status.status, status.run);
}
```
