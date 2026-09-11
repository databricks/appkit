# Function: formatResultsJson()

```ts
function formatResultsJson(results: EvalResult[]): string;
```

Render results as a machine-readable JSON report (2-space indented):
`{ summary: EvalSummary, results: EvalResult[] }`. Faithful to the types —
every field present on a result round-trips.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `results` | [`EvalResult`](Interface.EvalResult.md)[] |

## Returns

`string`
