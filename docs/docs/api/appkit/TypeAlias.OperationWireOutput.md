# Type Alias: OperationWireOutput\<Operation\>

```ts
type OperationWireOutput<Operation> = Operation extends OperationDefinition<infer E, infer M, infer _I, infer O, infer _R, infer _Name> ? WireOutputOf<E, M, O> : never;
```

The JSON a successful call answers with; a bigint travels as a decimal string.

## Type Parameters

| Type Parameter |
| ------ |
| `Operation` |
