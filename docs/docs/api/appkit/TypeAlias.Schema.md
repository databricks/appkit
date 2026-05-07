# Type Alias: Schema\<T\>

```ts
type Schema<T> = T & {
  $drizzle: unknown;
  $migrations: {
     snapshotHints: unknown;
  };
  $schemaName: string;
  $tables: Record<string, AppKitTable>;
};
```

A schema. This is used to define the schema for the database.

## Type Declaration

### $drizzle

```ts
readonly $drizzle: unknown;
```

### $migrations

```ts
readonly $migrations: {
  snapshotHints: unknown;
};
```

#### $migrations.snapshotHints

```ts
snapshotHints: unknown;
```

### $schemaName

```ts
readonly $schemaName: string;
```

Postgres schema namespace declared via `defineSchema(..., { schemaName })`.
Consumed by the database plugin (route/postgrest layer) and the
introspector so downstream code never has to re-configure what the schema
already knows about itself.

### $tables

```ts
readonly $tables: Record<string, AppKitTable>;
```

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` *extends* `Record`\<`string`, `unknown`\> | `Record`\<`string`, `unknown`\> |
