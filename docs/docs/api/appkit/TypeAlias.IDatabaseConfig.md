# Type Alias: IDatabaseConfig\<TSchema\>

```ts
type IDatabaseConfig<TSchema> = {
  api?: DatabaseApiConfig<TSchema>;
  hooks?: { readonly [TTable in SchemaTableName<TSchema>]?: EntityHooks<TTable> };
  routes?: DatabaseRoutes;
  schema?: TSchema;
};
```

Configuration for one schema-bound DatabasePlugin instance.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TSchema` *extends* [`Schema`](Interface.Schema.md) | `DefaultDatabaseSchema` |

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

### routes?

```ts
readonly optional routes: DatabaseRoutes;
```

Operations exposed over HTTP under `/api/database`, keyed
`"METHOD /path"`. Each runs through the same pipeline: the actor comes from
the Apps proxy (`x-forwarded-user`), the input is validated, `authorize`
must return `true`, then `execute` runs as the service principal.

When omitted, setup merges the default exports of
`config/database/routes/*.ts`. Passing `routes` disables that discovery.
A route that overlaps another or a generated CRUD route fails setup.

***

### schema?

```ts
readonly optional schema: TSchema;
```

Explicit schema override. When omitted, setup loads the named `schema`
export from `config/database/schema.ts` under the application's working
directory. Missing or invalid declarations fail setup before pool creation.
