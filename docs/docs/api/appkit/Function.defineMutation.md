# Function: defineMutation()

```ts
function defineMutation<S, R>(definition: OperationDefinition<S, R>): Operation<S, R>;
```

A state change. `authorize` and `execute` share one transaction, so a refusal or failure rolls back.

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
