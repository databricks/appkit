# Type Alias: EntityHooks\<TTable\>

```ts
type EntityHooks<TTable> = EntityMutationHooks<TTable> & {
  serialize?: ReadSerializer;
};
```

Response shaping and mutation lifecycle declared for one table.

## Type Declaration

### serialize?

```ts
readonly optional serialize: ReadSerializer;
```

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TTable` *extends* `string` | `string` |
