# Function: runWithRetries()

```ts
function runWithRetries(retries: number, attempt: (attemptNumber: number) => Promise<EvalResult>): Promise<EvalResult>;
```

Run `attempt` up to `1 + retries` times, stopping as soon as it returns a
result without an `error` (infra failures — thrown errors or timeouts — set
`error`; assertion failures do not, so a failed-but-completed eval is returned
on the first try and never retried). Returns the last result when every
attempt errored. `retries` below 0 is treated as 0.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `retries` | `number` |
| `attempt` | (`attemptNumber`: `number`) => `Promise`\<[`EvalResult`](Interface.EvalResult.md)\> |

## Returns

`Promise`\<[`EvalResult`](Interface.EvalResult.md)\>
