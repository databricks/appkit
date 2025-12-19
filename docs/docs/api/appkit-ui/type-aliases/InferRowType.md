# Type Alias: InferRowType\<K\>

```ts
type InferRowType<K> = K extends AugmentedRegistry<QueryRegistry> ? QueryRegistry[K] extends object ? R extends Record<string, unknown> ? R : Record<string, unknown> : Record<string, unknown> : Record<string, unknown>;
```

Defined in: [packages/appkit-ui/src/react/hooks/types.ts:106](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/hooks/types.ts#L106)

Infers the row type from a query result array.
Used for TypedArrowTable row typing.

## Type Parameters

| Type Parameter |
| ------ |
| `K` |
