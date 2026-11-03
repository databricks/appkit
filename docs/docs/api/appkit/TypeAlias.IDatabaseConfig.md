# Type Alias: IDatabaseConfig\<TSchema\>

```ts
type IDatabaseConfig<TSchema> = {
  pool?: DatabasePoolConfig;
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

### pool?

```ts
readonly optional pool: DatabasePoolConfig;
```

Overrides for the connection pool. A warning is logged when callers queue
because every connection is in use.

***

### routes?

```ts
readonly optional routes: DatabaseRoutes | false;
```

By default, discover `server/database/routes/` through the generated
`server/database/routes.gen.ts` registry. The standard server build includes
its compiled entry automatically. Without any route sources, serve nothing.
Pass `false` to disable discovery and HTTP operations, or a generated
registry to override the convention.

Setup loads its schema and every module it lists, then serves each
authorized operation at `/api/database/operations/:name` with its
declared method. An operation without `authorize` is skipped with a
warning. A malformed or duplicate operation, or a module that fails to
load, fails setup.

`appkit.database` stays available to server code in all three cases.

***

### schema?

```ts
readonly optional schema: TSchema;
```

Explicit schema override. Otherwise, setup loads the discovered registry's
schema or the named `schema` export from `config/database/schema.ts` under
the application's working directory. With an explicit `routes` registry,
this must be the same schema object the registry loads. Missing or invalid
declarations fail setup before pool creation.
