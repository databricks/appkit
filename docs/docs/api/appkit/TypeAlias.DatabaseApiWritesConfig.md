# Type Alias: DatabaseApiWritesConfig\<TSchema\>

```ts
type DatabaseApiWritesConfig<TSchema> =
  | boolean
  | {
  operations?: readonly DatabaseApiWriteOperation[];
  tables?: readonly SchemaTableName<TSchema>[];
};
```

All writes by default; false keeps reads only, and an object narrows writes.

## Type Parameters

| Type Parameter |
| ------ |
| `TSchema` *extends* [`Schema`](Interface.Schema.md) |

## Type Declaration

`boolean`

```ts
{
  operations?: readonly DatabaseApiWriteOperation[];
  tables?: readonly SchemaTableName<TSchema>[];
}
```

### operations?

```ts
readonly optional operations: readonly DatabaseApiWriteOperation[];
```

Operations that remain enabled. Defaults to create, update, and delete.

### tables?

```ts
readonly optional tables: readonly SchemaTableName<TSchema>[];
```

Tables that remain writable. Defaults to every exposed table.
