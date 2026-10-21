# Function: defineQuery()

```ts
function defineQuery<S, R>(definition: OperationDefinition<S, R>): Operation<S, R>;
```

A read. Runs `authorize` then `execute` outside a transaction.

## Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\> |
| `R` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | `OperationDefinition`\<`S`, `R`\> |

## Returns

[`Operation`](Interface.Operation.md)\<`S`, `R`\>
