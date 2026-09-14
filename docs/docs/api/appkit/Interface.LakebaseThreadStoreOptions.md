# Interface: LakebaseThreadStoreOptions

## Properties

### pool?

```ts
optional pool: Pool;
```

An existing `pg.Pool` to run on. When omitted, the store creates its own
pool via `createLakebasePool()` (OAuth token refresh handled inside) and
closes it on [LakebaseThreadStore.close](Class.LakebaseThreadStore.md#close). An injected pool is never
closed — the caller owns its lifecycle.

***

### tableSchema?

```ts
optional tableSchema: string;
```

Optional Postgres schema to hold the two tables. Created on init if it
does not exist. Defaults to the connection's search_path (usually
`public`). Validated as a plain lowercase identifier — it is interpolated
into DDL, not parameterizable, so anything else is rejected.
