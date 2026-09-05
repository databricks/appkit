# Type Alias: DatabaseApiConfig\<TSchema\>

```ts
type DatabaseApiConfig<TSchema> =
  | boolean
  | {
  tables?: readonly SchemaTableName<TSchema>[];
  writes?: DatabaseApiWritesConfig<TSchema>;
};
```

Full generated CRUD for every declared table by default. Set false to disable
all generated routes, or use an object to restrict tables and writes.
Keyed routes require a public primary key; upsert stays programmatic.
Route names must start with a letter, contain only letters, digits, `_`, or
`-`, be at most 64 characters, and be unique ignoring case. Invalid names
fail setup; exclude internal tables with `api.tables` or use `api: false`.

Routes run as the app's service principal and apply no per-user filter, so
anyone the app admits receives every enabled operation. An exposed table
also becomes includable from its neighbours; a relation whose target
stays off cannot be included.

Text filters accept caller-supplied `like`/`ilike` patterns; a server-side
`statement_timeout` cancels a pattern that would otherwise hold its pooled
connection to completion.

## Type Parameters

| Type Parameter |
| ------ |
| `TSchema` *extends* [`Schema`](Interface.Schema.md) |

## Type Declaration

`boolean`

```ts
{
  tables?: readonly SchemaTableName<TSchema>[];
  writes?: DatabaseApiWritesConfig<TSchema>;
}
```

### tables?

```ts
readonly optional tables: readonly SchemaTableName<TSchema>[];
```

Tables that remain exposed. Defaults to every declared table.

### writes?

```ts
readonly optional writes: DatabaseApiWritesConfig<TSchema>;
```

All writes by default. Set false for read-only routes.
