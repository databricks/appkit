# Function: isSQLTypeMarker()

```ts
function isSQLTypeMarker(value: any): value is SQLTypeMarker;
```

Type guard to check if a value is a SQL type marker

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `any` | Value to check |

## Returns

`value is SQLTypeMarker`

True if the value is a SQL type marker, false otherwise

## Example

```typescript
const value = {
  __sql_type: "DATE",
  value: "2024-01-01",
};
const isSQLTypeMarker = isSQLTypeMarker(value);
console.log(isSQLTypeMarker); // true
```
