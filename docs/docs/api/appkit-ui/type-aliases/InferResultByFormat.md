# Type Alias: InferResultByFormat\<T, K, F\>

```ts
type InferResultByFormat<T, K, F> = F extends "ARROW" ? TypedArrowTable<InferRowType<K>> : InferResult<T, K>;
```

Defined in: [packages/appkit-ui/src/react/hooks/types.ts:119](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/hooks/types.ts#L119)

Conditionally infers result type based on format.
- JSON format: Returns the typed array from QueryRegistry
- ARROW format: Returns TypedArrowTable with row type preserved

## Type Parameters

| Type Parameter |
| ------ |
| `T` |
| `K` |
| `F` *extends* [`AnalyticsFormat`](AnalyticsFormat.md) |
