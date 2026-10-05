# Type Alias: AiFunctionTaskInput\<T\>

```ts
type AiFunctionTaskInput<T> = T extends {
  function: "decide";
} ? {
  state: StructuredInput;
} : {
  content: string | StructuredObject;
};
```

`{ content }` for classify and extract, `{ state }` for decide.

## Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* [`AiFunctionTask`](TypeAlias.AiFunctionTask.md) |
