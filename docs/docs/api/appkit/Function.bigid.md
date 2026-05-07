# Function: bigid()

```ts
function bigid(): AppKitColumnChain;
```

Create an int8 (bigserial) primary-key column.

Maps to Postgres `bigserial` (8-byte integer with an attached sequence).
`appkit db introspect` emits this for live `bigserial`/`int8 + nextval()`
primary keys so the round-trip stays drift-free.

## Returns

[`AppKitColumnChain`](Interface.AppKitColumnChain.md)
