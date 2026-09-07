# Function: runEval()

```ts
function runEval(def: EvalDefinition, options: RunEvalOptions): Promise<EvalResult>;
```

Run a single eval against a driver. Never throws for assertion or agent
failures — those become a non-passing [EvalResult](Interface.EvalResult.md). Only a malformed
eval definition surfaces as `result.error`.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `def` | [`EvalDefinition`](Interface.EvalDefinition.md) |
| `options` | [`RunEvalOptions`](Interface.RunEvalOptions.md) |

## Returns

`Promise`\<[`EvalResult`](Interface.EvalResult.md)\>
