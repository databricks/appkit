# Function: runWithRetries()

```ts
function runWithRetries(
   retries: number, 
   attempt: (attemptNumber: number) => Promise<EvalResult>, 
   options: {
  baseDelayMs?: number;
}): Promise<EvalResult>;
```

Run `attempt` up to `1 + retries` times, stopping as soon as it returns a
result that is neither a thrown error / per-eval timeout (`error`) nor a
transport/agent turn failure (`infraFailure`). Assertion failures set
neither, so a failed-but-completed eval is returned on the first try and
never retried. Returns the last result when every attempt failed on infra.

Between attempts it waits a full-jittered exponential backoff (infra flakes
are overload-correlated). `retries` is coerced to a finite non-negative
integer; `baseDelayMs: 0` disables the wait (tests).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `retries` | `number` |
| `attempt` | (`attemptNumber`: `number`) => `Promise`\<[`EvalResult`](Interface.EvalResult.md)\> |
| `options` | \{ `baseDelayMs?`: `number`; \} |
| `options.baseDelayMs?` | `number` |

## Returns

`Promise`\<[`EvalResult`](Interface.EvalResult.md)\>
