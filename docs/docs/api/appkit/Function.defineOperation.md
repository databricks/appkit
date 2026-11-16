# Function: defineOperation()

## Call Signature

```ts
function defineOperation<Name, M, I, O, R>(definition: OperationFields<M, I, O, Name> & {
  authorize: ResourcePolicy<ParsedInput<I>, R>;
  execute: (context: OperationContext<ParsedInput<I>, NonNullable<Awaited<R>>>) => Awaitable<ExecuteResult<M, O>>;
}): OperationDefinition<M, I, O, R, Name>;
```

Declare one database operation. `name` is its public identifier. Declare an
`input` Zod schema to accept parameters; without one, callbacks receive
`undefined`. Declare an `output` Zod schema to answer a body; without one,
the operation answers none. Definition only freezes a descriptor.

### Type Parameters

| Type Parameter |
| ------ |
| `Name` *extends* `string` |
| `M` *extends* `DatabaseOperationMethod` |
| `I` *extends* `SchemaSlot` |
| `O` *extends* `SchemaSlot` |
| `R` *extends* \{ \} |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | `OperationFields`\<`M`, `I`, `O`, `Name`\> & \{ `authorize`: `ResourcePolicy`\<`ParsedInput`\<`I`\>, `R`\>; `execute`: (`context`: [`OperationContext`](Interface.OperationContext.md)\<`ParsedInput`\<`I`\>, `NonNullable`\<`Awaited`\<`R`\>\>\>) => `Awaitable`\<`ExecuteResult`\<`M`, `O`\>\>; \} |

### Returns

[`OperationDefinition`](Interface.OperationDefinition.md)\<`M`, `I`, `O`, `R`, `Name`\>

## Call Signature

```ts
function defineOperation<Name, M, I, O>(definition: OperationOptions<M, I, O, undefined, Name>): OperationDefinition<M, I, O, undefined, Name>;
```

Declare one database operation. `name` is its public identifier. Declare an
`input` Zod schema to accept parameters; without one, callbacks receive
`undefined`. Declare an `output` Zod schema to answer a body; without one,
the operation answers none. Definition only freezes a descriptor.

### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `Name` *extends* `string` | - |
| `M` *extends* `DatabaseOperationMethod` | - |
| `I` *extends* `SchemaSlot` | `undefined` |
| `O` *extends* `SchemaSlot` | `undefined` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | `OperationOptions`\<`M`, `I`, `O`, `undefined`, `Name`\> |

### Returns

[`OperationDefinition`](Interface.OperationDefinition.md)\<`M`, `I`, `O`, `undefined`, `Name`\>
