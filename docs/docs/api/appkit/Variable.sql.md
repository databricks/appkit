# Variable: sql

```ts
const sql: {
  bigint: SQLNumberMarker;
  binary: SQLBinaryMarker;
  boolean: SQLBooleanMarker;
  date: SQLDateMarker;
  decimal: SQLNumberMarker;
  double: SQLNumberMarker;
  float: SQLNumberMarker;
  int: SQLNumberMarker;
  number: SQLNumberMarker;
  string: SQLStringMarker;
  timestamp: SQLTimestampMarker;
};
```

SQL helper namespace

## Type Declaration

### bigint()

```ts
bigint(value: string | number | bigint): SQLNumberMarker;
```

Creates a `BIGINT` (64-bit signed integer) parameter. Accepts JS
`bigint` so callers can round-trip values outside `Number.MAX_SAFE_INTEGER`
without precision loss.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` \| `bigint` | Integer number, bigint, or integer-shaped string |

#### Returns

`SQLNumberMarker`

### binary()

```ts
binary(value: string | Uint8Array | ArrayBuffer): SQLBinaryMarker;
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
boolean(value: string | number | boolean): SQLBooleanMarker;
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
date(value: string | Date): SQLDateMarker;
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

### decimal()

```ts
decimal(value: string | number): SQLNumberMarker;
```

Creates a `NUMERIC` (fixed-point DECIMAL) parameter. Use when you need
exact decimal arithmetic (currency, percentages) — pass values as
strings to avoid JS-number precision loss.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` | Number or numeric string (strings preferred for precision) |

#### Returns

`SQLNumberMarker`

### double()

```ts
double(value: string | number): SQLNumberMarker;
```

Creates a `DOUBLE` (double-precision) parameter. Same precision as a JS
`number`, so `sql.double(value)` is exact for any JS number.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` | Number or numeric string |

#### Returns

`SQLNumberMarker`

### float()

```ts
float(value: string | number): SQLNumberMarker;
```

Creates a `FLOAT` (single-precision) parameter.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` | Number or numeric string |

#### Returns

`SQLNumberMarker`

### int()

```ts
int(value: string | number): SQLNumberMarker;
```

Creates an `INT` (32-bit signed integer) parameter. Use when the column
or context requires `INT` specifically (e.g. legacy schemas, or to make
the wire type explicit).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` | Integer number or integer-shaped string |

#### Returns

`SQLNumberMarker`

### number()

```ts
number(value: string | number): SQLNumberMarker;
```

Creates a numeric type parameter. The wire SQL type is inferred from the
value so the parameter binds correctly in any context, including `LIMIT`
and `OFFSET` (which require integer types):

- JS integer (`10`) → `BIGINT`
- JS non-integer (`3.14`) → `DOUBLE`
- numeric string (`"123.45"`) → `NUMERIC` (preserves caller's precision intent)

Reach for `sql.int()`, `sql.bigint()`, `sql.float()`, `sql.double()`, or
`sql.decimal()` if you need to override the inferred type.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` | Number or numeric string |

#### Returns

`SQLNumberMarker`

Marker for a numeric SQL parameter

#### Example

```typescript
const params = { userId: sql.number(123) };       // BIGINT, value "123"
const params = { ratio: sql.number(0.5) };        // DOUBLE, value "0.5"
const params = { amount: sql.number("123.45") };  // NUMERIC, value "123.45"
```

### string()

```ts
string(value: string | number | boolean): SQLStringMarker;
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
timestamp(value: string | number | Date): SQLTimestampMarker;
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
