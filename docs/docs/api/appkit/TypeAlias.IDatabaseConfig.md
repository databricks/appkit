# Type Alias: IDatabaseConfig\<TSchema\>

```ts
type IDatabaseConfig<TSchema> = {
  crudRoutes?: CrudRoutesConfig<TSchema>;
  hooks?: { readonly [TTable in SchemaTableName<TSchema>]?: EntityHooks<TTable> };
  schema: TSchema;
};
```

Configuration for one schema-bound DatabasePlugin instance.

## Type Parameters

| Type Parameter |
| ------ |
| `TSchema` *extends* [`Schema`](Interface.Schema.md) |

## Properties

### crudRoutes?

```ts
readonly optional crudRoutes: CrudRoutesConfig<TSchema>;
```

***

### hooks?

```ts
readonly optional hooks: { readonly [TTable in SchemaTableName<TSchema>]?: EntityHooks<TTable> };
```

***

### schema

```ts
readonly schema: TSchema;
```
