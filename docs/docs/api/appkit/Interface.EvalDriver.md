# Interface: EvalDriver

Abstraction over how the agent is driven. The HTTP driver posts to a running
app's agents endpoint; future drivers (in-process) implement the same shape.

## Methods

### reset()?

```ts
optional reset(): void;
```

Drop the current conversation so the next `send` starts a fresh thread.
Optional: drivers without a session concept omit it.

#### Returns

`void`

***

### send()

```ts
send(message: string, options?: {
  signal?: AbortSignal;
}): Promise<DriveResult>;
```

Drive one turn. `options.signal`, when provided, aborts the in-flight turn:
the runner passes its per-eval timeout signal so a timed-out eval cancels
the request instead of leaking a live stream.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `options?` | \{ `signal?`: `AbortSignal`; \} |
| `options.signal?` | `AbortSignal` |

#### Returns

`Promise`\<[`DriveResult`](Interface.DriveResult.md)\>
