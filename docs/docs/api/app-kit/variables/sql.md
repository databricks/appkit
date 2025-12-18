# Variable: sql

```ts
const sql: object;
```

Defined in: [shared/src/sql/helpers.ts:14](https://github.com/databricks/app-kit/blob/main/packages/shared/src/sql/helpers.ts#L14)

SQL helper namespace

## Type Declaration

### binary()

```ts
binary(value): SQLBinaryMarker;
```

Creates a BINARY parameter as hex-encoded STRING
Accepts Uint8Array, ArrayBuffer, or hex string
Note: Databricks SQL Warehouse doesn't support BINARY as parameter type,
so this helper returns a STRING with hex encoding. Use UNHEX(:param) in your SQL.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `Uint8Array` \| `ArrayBuffer` | Uint8Array, ArrayBuffer, or hex string |

#### Returns

`SQLBinaryMarker`

Marker object with STRING type and hex-encoded value

#### Examples

```typescript
// From Uint8Array:
const params = { data: sql.binary(new Uint8Array([0x53, 0x70, 0x61, 0x72, 0x6b])) };
// Returns: { __sql_type: "STRING", value: "537061726B" }
// SQL: SELECT UNHEX(:data) as binary_value
```

```typescript
// From hex string:
const params = { data: sql.binary("537061726B") };
// Returns: { __sql_type: "STRING", value: "537061726B" }
```

### boolean()

```ts
boolean(value): SQLBooleanMarker;
```

Create a BOOLEAN type parameter
Accepts booleans, strings, or numbers

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` \| `boolean` | Boolean, string, or number |

#### Returns

`SQLBooleanMarker`

Marker object for BOOLEAN type parameter

#### Examples

```typescript
const params = { isActive: sql.boolean(true) };
params = { isActive: "true" }
```

```typescript
const params = { isActive: sql.boolean("true") };
params = { isActive: "true" }
```

```typescript
const params = { isActive: sql.boolean(1) };
params = { isActive: "true" }
```

```typescript
const params = { isActive: sql.boolean("false") };
params = { isActive: "false" }
```

```typescript
const params = { isActive: sql.boolean(0) };
params = { isActive: "false" }
```

### date()

```ts
date(value): SQLDateMarker;
```

Creates a DATE type parameter
Accepts Date objects or ISO date strings (YYYY-MM-DD format)

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `Date` | Date object or ISO date string |

#### Returns

`SQLDateMarker`

Marker object for DATE type parameter

#### Examples

```typescript
const params = { startDate: sql.date(new Date("2024-01-01")) };
params = { startDate: "2024-01-01" }
```

```typescript
const params = { startDate: sql.date("2024-01-01") };
params = { startDate: "2024-01-01" }
```

### number()

```ts
number(value): SQLNumberMarker;
```

Creates a NUMERIC type parameter
Accepts numbers or numeric strings

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` | Number or numeric string |

#### Returns

`SQLNumberMarker`

Marker object for NUMERIC type parameter

#### Examples

```typescript
const params = { userId: sql.number(123) };
params = { userId: "123" }
```

```typescript
const params = { userId: sql.number("123") };
params = { userId: "123" }
```

### string()

```ts
string(value): SQLStringMarker;
```

Creates a STRING type parameter
Accepts strings, numbers, or booleans

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` \| `boolean` | String, number, or boolean |

#### Returns

`SQLStringMarker`

Marker object for STRING type parameter

#### Examples

```typescript
const params = { name: sql.string("John") };
params = { name: "John" }
```

```typescript
const params = { name: sql.string(123) };
params = { name: "123" }
```

```typescript
const params = { name: sql.string(true) };
params = { name: "true" }
```

### timestamp()

```ts
timestamp(value): SQLTimestampMarker;
```

Creates a TIMESTAMP type parameter
Accepts Date objects, ISO timestamp strings, or Unix timestamp numbers

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` \| `Date` | Date object, ISO timestamp string, or Unix timestamp number |

#### Returns

`SQLTimestampMarker`

Marker object for TIMESTAMP type parameter

#### Examples

```typescript
const params = { createdTime: sql.timestamp(new Date("2024-01-01T12:00:00Z")) };
params = { createdTime: "2024-01-01T12:00:00Z" }
```

```typescript
const params = { createdTime: sql.timestamp("2024-01-01T12:00:00Z") };
params = { createdTime: "2024-01-01T12:00:00Z" }
```

```typescript
const params = { createdTime: sql.timestamp(1704110400000) };
params = { createdTime: "2024-01-01T12:00:00Z" }
```
