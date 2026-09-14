# Type Alias: TransactionClient

```ts
type TransactionClient = { readonly [K in EntityName]: TypedEntityClient<K> } & {
  sql: SqlTag;
};
```

Entity and SQL capabilities bound to one transaction.

## Type Declaration

### sql

```ts
readonly sql: SqlTag;
```
