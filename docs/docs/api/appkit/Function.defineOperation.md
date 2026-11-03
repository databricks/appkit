# Function: defineOperation()

## Call Signature

```ts
function defineOperation<Name, E, M, I, O, R>(definition: OperationFields<E, M, I, O, Name> & {
  authorize: ResourcePolicy<ParsedInput<I>, R>;
  execute: (context: OperationContext<ParsedInput<I>, NonNullable<Awaited<R>>>) => Awaitable<ExecuteResult<E, M, O>>;
}): OperationDefinition<E, M, I, O, R, Name>;
```

Declare one database operation. `name` is its public identifier. The entity
and method infer the default output. Declare an `input` Zod schema to accept
parameters; without one, callbacks receive `undefined`. An `output` schema
overrides the default response. Definition only freezes a descriptor.

### Type Parameters

| Type Parameter |
| ------ |
| `Name` *extends* `string` |
| `E` *extends* `never` |
| `M` *extends* `DatabaseOperationMethod` |
| `I` *extends* `SchemaSlot` |
| `O` *extends* `SchemaSlot` |
| `R` *extends* \{ \} |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | `OperationFields`\<`E`, `M`, `I`, `O`, `Name`\> & \{ `authorize`: `ResourcePolicy`\<`ParsedInput`\<`I`\>, `R`\>; `execute`: (`context`: [`OperationContext`](Interface.OperationContext.md)\<`ParsedInput`\<`I`\>, `NonNullable`\<`Awaited`\<`R`\>\>\>) => `Awaitable`\<`ExecuteResult`\<`E`, `M`, `O`\>\>; \} |

### Returns

[`OperationDefinition`](Interface.OperationDefinition.md)\<`E`, `M`, `I`, `O`, `R`, `Name`\>

## Call Signature

```ts
function defineOperation<Name, E, M, I, O>(definition: OperationOptions<E, M, I, O, undefined, Name>): OperationDefinition<E, M, I, O, undefined, Name>;
```

Declare one database operation. `name` is its public identifier. The entity
and method infer the default output. Declare an `input` Zod schema to accept
parameters; without one, callbacks receive `undefined`. An `output` schema
overrides the default response. Definition only freezes a descriptor.

### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `Name` *extends* `string` | - |
| `E` *extends* `never` | - |
| `M` *extends* `DatabaseOperationMethod` | - |
| `I` *extends* `SchemaSlot` | `undefined` |
| `O` *extends* `SchemaSlot` | `undefined` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | `OperationOptions`\<`E`, `M`, `I`, `O`, `undefined`, `Name`\> |

### Returns

[`OperationDefinition`](Interface.OperationDefinition.md)\<`E`, `M`, `I`, `O`, `undefined`, `Name`\>
