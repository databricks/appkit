# Type Alias: SQLTypeMarker

```ts
type SQLTypeMarker = 
  | SQLStringMarker
  | SQLNumberMarker
  | SQLBooleanMarker
  | SQLBinaryMarker
  | SQLDateMarker
  | SQLTimestampMarker;
```

Defined in: [shared/src/sql/types.ts:36](https://github.com/databricks/app-kit/blob/main/packages/shared/src/sql/types.ts#L36)

Object that identifies a typed SQL parameter.
Created using sql.date(), sql.string(), sql.number(), sql.boolean(), sql.timestamp(), sql.binary(), or sql.interval().
