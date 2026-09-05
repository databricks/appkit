# Function: createHttpDriver()

```ts
function createHttpDriver(options: HttpDriverOptions): EvalDriver;
```

Drives an agent by POSTing to a running app's chat endpoint and parsing the
SSE response. Keeps the thread id across `send`s so multi-turn evals share a
conversation. Agent/stream errors surface as `succeeded: false` rather than
throwing, so `t.succeeded()` can assert on them.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`HttpDriverOptions`](Interface.HttpDriverOptions.md) |

## Returns

[`EvalDriver`](Interface.EvalDriver.md)
