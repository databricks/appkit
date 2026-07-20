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
send(message: string): Promise<DriveResult>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |

#### Returns

`Promise`\<[`DriveResult`](Interface.DriveResult.md)\>
