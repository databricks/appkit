# Type Alias: IDatabaseConfig\<TSchema\>

```ts
type IDatabaseConfig<TSchema> = {
  api?: DatabaseApiConfig<TSchema>;
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

### api?

```ts
readonly optional api: DatabaseApiConfig<TSchema>;
```

Generated HTTP CRUD is enabled for all tables by default, using the app's
service principal. Every admitted caller receives the enabled operations;
no per-user or per-row authorization is applied. This plugin does not
support OBO. Use custom routes for application-specific authorization.

Set `false` to disable routes, `{ writes: false }` for reads only, or
`{ tables: ["notes"] }` to expose only selected tables. To disable delete,
use `{ writes: { operations: ["create", "update"] } }`.

#### Default Value

```ts
true
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
