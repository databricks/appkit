# Function: reportToMlflow()

```ts
function reportToMlflow(
   client: MlflowClient, 
   results: EvalResult[], 
sqlWarehouseId?: string): Promise<ReportOutcome>;
```

Write one pass/fail assessment per eval result to the Databricks MLflow REST
API. Never throws — failures are collected so the run still reports.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `client` | [`MlflowClient`](Class.MlflowClient.md) |
| `results` | [`EvalResult`](Interface.EvalResult.md)[] |
| `sqlWarehouseId?` | `string` |

## Returns

`Promise`\<[`ReportOutcome`](Interface.ReportOutcome.md)\>
