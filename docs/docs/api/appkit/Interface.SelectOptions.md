# Interface: SelectOptions

Options accepted by `DataPath.select`.

## Properties

### columns?

```ts
optional columns: readonly string[];
```

Project specific columns. Defaults to `*`.

***

### include?

```ts
optional include: IncludeSpec;
```

Eager-load related entities.

***

### limit?

```ts
optional limit: number;
```

***

### offset?

```ts
optional offset: number;
```

***

### order?

```ts
optional order: OrderSpec;
```

***

### signal?

```ts
optional signal: AbortSignal;
```

Reserved. `node-postgres` does not honor `AbortSignal` at the query level
today — runaway queries are bounded server-side by Postgres
`statement_timeout` (set by the plugin on every pool connection). The
AppKit timeout interceptor still rejects the JS promise when fired.

***

### where?

```ts
optional where: WhereSpec;
```
