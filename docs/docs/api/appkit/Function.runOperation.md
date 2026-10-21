# Function: runOperation()

```ts
function runOperation<S, R>(
   operation: Operation<S, R>, 
   call: {
  actor: Actor | undefined;
  input: unknown;
}, 
db: DatabaseExports): Promise<R>;
```

The one execution path for an operation, whoever calls it: validate the
input, authorize, then execute with the service-principal `db`.

## Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\> |
| `R` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `operation` | [`Operation`](Interface.Operation.md)\<`S`, `R`\> |
| `call` | \{ `actor`: [`Actor`](Interface.Actor.md) \| `undefined`; `input`: `unknown`; \} |
| `call.actor` | [`Actor`](Interface.Actor.md) \| `undefined` |
| `call.input` | `unknown` |
| `db` | [`DatabaseExports`](TypeAlias.DatabaseExports.md) |

## Returns

`Promise`\<`R`\>
