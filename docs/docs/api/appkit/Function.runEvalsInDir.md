# Function: runEvalsInDir()

```ts
function runEvalsInDir(options: RunEvalsOptions): Promise<EvalRunSummary>;
```

Discover, load, and run every eval under each agent's `evals/` dir, driving
the agents on a running app. Never throws for an individual eval — load/run
failures become non-passing [EvalResult](Interface.EvalResult.md)s.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`RunEvalsOptions`](Interface.RunEvalsOptions.md) |

## Returns

`Promise`\<[`EvalRunSummary`](Interface.EvalRunSummary.md)\>
