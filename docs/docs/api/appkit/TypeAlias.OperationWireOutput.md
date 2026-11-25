# Type Alias: OperationWireOutput\<Operation\>

```ts
type OperationWireOutput<Operation> = Operation extends OperationDefinition<infer M, infer _I, infer O, infer _R, infer _Name> ? WireOutputOf<M, O> : never;
```

The JSON a successful call answers with; without an output schema there is none.

## Type Parameters

| Type Parameter |
| ------ |
| `Operation` |
