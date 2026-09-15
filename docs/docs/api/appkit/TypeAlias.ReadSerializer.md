# Type Alias: ReadSerializer()

```ts
type ReadSerializer = (row: Record<string, unknown>, context: ReadSerializerContext) => Record<string, unknown>;
```

Shape one already private-safe row before it reaches the wire. A `Promise`
is not assignable to the return type, so an async callback fails to compile:
serializers run inside the response path and must not add latency there.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `row` | `Record`\<`string`, `unknown`\> |
| `context` | [`ReadSerializerContext`](Interface.ReadSerializerContext.md) |

## Returns

`Record`\<`string`, `unknown`\>
