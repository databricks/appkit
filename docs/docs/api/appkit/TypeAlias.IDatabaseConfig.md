# Type Alias: IDatabaseConfig\<TSchema\>

```ts
type IDatabaseConfig<TSchema> = {
  routes?: DatabaseRoutes | false;
  schema?: TSchema;
};
```

Configuration for one schema-bound DatabasePlugin instance.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TSchema` *extends* [`Schema`](Interface.Schema.md) | `DefaultDatabaseSchema` |

## Properties

### routes?

```ts
readonly optional routes: DatabaseRoutes | false;
```

The generated registry of named operations: `database({ routes: databaseRoutes })`.
Setup loads its schema and every module it lists, then serves each
authorized operation at `/api/database/operations/:name` with its
declared method. An operation without `authorize` is skipped with a
warning. A malformed or duplicate operation, or a module that fails to
load, fails setup.

Absent or `false` serves no database endpoint over HTTP; `appkit.database`
stays available to server code either way.

***

### schema?

```ts
readonly optional schema: TSchema;
```

Explicit schema override. Without `routes`, setup otherwise loads the
named `schema` export from `config/database/schema.ts` under the
application's working directory. With `routes`, setup uses the schema the
registry loads, and a different `schema` here fails setup. Missing or
invalid declarations fail setup before pool creation.
