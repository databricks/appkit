# Function: buildAssessment()

```ts
function buildAssessment(result: EvalResult): Assessment | undefined;
```

Build the single pass/fail Feedback assessment for an eval result. Returns
undefined when there's no trace to attach to or the eval was skipped.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `result` | [`EvalResult`](Interface.EvalResult.md) |

## Returns

[`Assessment`](Interface.Assessment.md) \| `undefined`
