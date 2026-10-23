# Type Alias: OperationWireInput\<Operation\>

```ts
type OperationWireInput<Operation> = Operation extends OperationDefinition<infer E, infer M, infer I, infer _O, infer _R, infer _Name> ? WireInputOf<E, M, I> : never;
```

The JSON a caller sends to an operation; a bigint travels as a string or safe integer.

## Type Parameters

| Type Parameter |
| ------ |
| `Operation` |
