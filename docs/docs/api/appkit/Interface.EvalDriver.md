# Interface: EvalDriver

Abstraction over how the agent is driven. The HTTP driver posts to a running
app's agents endpoint; future drivers (in-process) implement the same shape.

## Methods

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
