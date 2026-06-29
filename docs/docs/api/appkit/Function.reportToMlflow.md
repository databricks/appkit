# Function: reportToMlflow()

```ts
function reportToMlflow(results: EvalResult[], options: MlflowReportOptions): Promise<ReportOutcome>;
```

Write one pass/fail assessment per eval result to the Databricks MLflow REST
API. Never throws — failures are collected so the run still reports.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `results` | [`EvalResult`](Interface.EvalResult.md)[] |
| `options` | [`MlflowReportOptions`](Interface.MlflowReportOptions.md) |

## Returns

`Promise`\<[`ReportOutcome`](Interface.ReportOutcome.md)\>
