# Function: formatResultsJUnit()

```ts
function formatResultsJUnit(results: EvalResult[]): string;
```

Render results as JUnit XML for standard CI test reporters: a single
`<testsuite name="appkit-agent-evals">` with one `<testcase>` per result.
Failures carry a `<failure>` (error or failing-gate summary); skips a
`<skipped>`. All attribute/text values are XML-escaped.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `results` | [`EvalResult`](Interface.EvalResult.md)[] |

## Returns

`string`
