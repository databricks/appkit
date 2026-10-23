# Function: defineOperation()

## Call Signature

```ts
function defineOperation<Name, E, M, I, O, R>(definition: {
  entity: E;
  method: M;
  name: Name;
  output?: O;
} & [Contract<E, M>["input"]] extends [never] ? {
  input: I & Schema;
} : {
  input?: I;
} & {
  authorize: ResourcePolicy<ParsedInput<E, M, I>, R>;
  execute: (context: OperationContext<ParsedInput<E, M, I>, NonNullable<Awaited<R>>>) => Awaitable<ExecuteResult<E, M, O>>;
}): OperationDefinition<E, M, I, O, R, Name>;
```

Declare one database operation. `name` is its public identifier. The entity
and method infer the default input and output; `input` and `output` Zod
schemas override them. Definition is pure: it freezes a descriptor and
calls nothing.

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
| `definition` | \{ `entity`: `E`; `method`: `M`; `name`: `Name`; `output?`: `O`; \} & \[`Contract`\<`E`, `M`\>\[`"input"`\]\] *extends* \[`never`\] ? \{ `input`: `I` & `Schema`; \} : \{ `input?`: `I`; \} & \{ `authorize`: `ResourcePolicy`\<`ParsedInput`\<`E`, `M`, `I`\>, `R`\>; `execute`: (`context`: [`OperationContext`](Interface.OperationContext.md)\<`ParsedInput`\<`E`, `M`, `I`\>, `NonNullable`\<`Awaited`\<`R`\>\>\>) => `Awaitable`\<`ExecuteResult`\<`E`, `M`, `O`\>\>; \} |

### Returns

[`OperationDefinition`](Interface.OperationDefinition.md)\<`E`, `M`, `I`, `O`, `R`, `Name`\>

## Call Signature

```ts
function defineOperation<Name, E, M, I, O>(definition: OperationOptions<E, M, I, O, undefined, Name>): OperationDefinition<E, M, I, O, undefined, Name>;
```

Declare one database operation. `name` is its public identifier. The entity
and method infer the default input and output; `input` and `output` Zod
schemas override them. Definition is pure: it freezes a descriptor and
calls nothing.

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
