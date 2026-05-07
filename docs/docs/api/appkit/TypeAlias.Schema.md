# Type Alias: Schema\<T\>

```ts
type Schema<T> = T & {
  $drizzle: unknown;
  $migrations: {
     snapshotHints: unknown;
  };
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

### $tables

```ts
readonly $tables: Record<string, AppKitTable>;
```

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` *extends* `Record`\<`string`, `unknown`\> | `Record`\<`string`, `unknown`\> |
