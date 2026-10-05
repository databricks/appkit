# Type Alias: AiFunctionTaskResult\<T\>

```ts
type AiFunctionTaskResult<T> = T extends {
  function: "classify";
  labels: infer L;
} ? ClassifyResponse<ClassifyLabel<L>> : T extends {
  function: "extract";
  schema: infer S;
} ? ExtractResponse<ExtractResult<S>> : T extends {
  function: "decide";
  questions: infer Q;
} ? DecideResponse<Q> : never;
```

The response type a task produces, inferred from its definition.

## Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* [`AiFunctionTask`](TypeAlias.AiFunctionTask.md) |
