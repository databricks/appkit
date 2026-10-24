# Type Alias: Policy()\<I\>

```ts
type Policy<I> = (context: OperationContext<I>) => 
  | PolicyResult
| Promise<PolicyResult>;
```

## Type Parameters

| Type Parameter |
| ------ |
| `I` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | [`OperationContext`](Interface.OperationContext.md)\<`I`\> |

## Returns

  \| [`PolicyResult`](TypeAlias.PolicyResult.md)
  \| `Promise`\<[`PolicyResult`](TypeAlias.PolicyResult.md)\>
