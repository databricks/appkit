# Function: id()

```ts
function id(): AppKitColumnChain;
```

Create an int4 (serial) primary-key column.

Maps to Postgres `serial` (4-byte integer with an attached sequence). Use
`bigid()` for tables that need more than ~2 billion rows or that mirror an
existing `bigserial` column from a brownfield database.

## Returns

[`AppKitColumnChain`](Interface.AppKitColumnChain.md)
