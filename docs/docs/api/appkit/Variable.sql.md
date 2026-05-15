# Variable: sql

```ts
const sql: {
  bigint: SQLNumberMarker & {
     __sql_type: "BIGINT";
  };
  binary: SQLBinaryMarker;
  boolean: SQLBooleanMarker;
  date: SQLDateMarker;
  double: SQLNumberMarker & {
     __sql_type: "DOUBLE";
  };
  float: SQLNumberMarker & {
     __sql_type: "FLOAT";
  };
  int: SQLNumberMarker & {
     __sql_type: "INT";
  };
  number: SQLNumberMarker;
  numeric: SQLNumberMarker & {
     __sql_type: "NUMERIC";
  };
  string: SQLStringMarker;
  timestamp: SQLTimestampMarker;
};
```

SQL helper namespace

## Type Declaration

### bigint()

```ts
bigint(value: string | number | bigint): SQLNumberMarker & {
  __sql_type: "BIGINT";
};
```

Creates a `BIGINT` (64-bit signed integer) parameter. Accepts JS
`bigint` so callers can round-trip values outside `Number.MAX_SAFE_INTEGER`
without precision loss; for `number` inputs, requires
`Number.isSafeInteger(value)`.

Rejects values outside the signed 64-bit range `[-2^63, 2^63 - 1]`.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` \| `bigint` | Integer number, bigint, or integer-shaped string |

#### Returns

`SQLNumberMarker` & \{
  `__sql_type`: `"BIGINT"`;
\}

Marker pinned to `BIGINT`

#### Example

```typescript
sql.bigint(42);                     // { __sql_type: "BIGINT", value: "42" }
sql.bigint(9007199254740993n);      // { __sql_type: "BIGINT", value: "9007199254740993" }
sql.bigint("9007199254740993");     // { __sql_type: "BIGINT", value: "9007199254740993" }
```

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

### double()

```ts
double(value: string | number): SQLNumberMarker & {
  __sql_type: "DOUBLE";
};
```

Creates a `DOUBLE` (double-precision, 64-bit) parameter. Same precision
as a JS `number`, so `sql.double(value)` is exact for any JS number.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` | Number or numeric string |

#### Returns

`SQLNumberMarker` & \{
  `__sql_type`: `"DOUBLE"`;
\}

Marker pinned to `DOUBLE`

#### Example

```typescript
sql.double(3.14);   // { __sql_type: "DOUBLE", value: "3.14" }
```

### float()

```ts
float(value: string | number): SQLNumberMarker & {
  __sql_type: "FLOAT";
};
```

Creates a `FLOAT` (single-precision, 32-bit) parameter. Note that JS
numbers are 64-bit doubles, so values may be rounded to fit FLOAT
precision at bind time.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` | Number or numeric string |

#### Returns

`SQLNumberMarker` & \{
  `__sql_type`: `"FLOAT"`;
\}

Marker pinned to `FLOAT`

#### Example

```typescript
sql.float(3.14);   // { __sql_type: "FLOAT", value: "3.14" }
```

### int()

```ts
int(value: string | number): SQLNumberMarker & {
  __sql_type: "INT";
};
```

Creates an `INT` (32-bit signed integer) parameter. Use when the column
or context requires `INT` specifically (e.g. legacy schemas, or to make
the wire type explicit).

Rejects non-integers, values outside `Number.MAX_SAFE_INTEGER` (for
number inputs), and values outside the signed 32-bit range
`[-2^31, 2^31 - 1]`.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` | Integer number or integer-shaped string |

#### Returns

`SQLNumberMarker` & \{
  `__sql_type`: `"INT"`;
\}

Marker pinned to `INT`

#### Example

```typescript
sql.int(42);     // { __sql_type: "INT", value: "42" }
sql.int("42");   // { __sql_type: "INT", value: "42" }
```

### number()

```ts
number(value: string | number): SQLNumberMarker;
```

Creates a numeric type parameter. The wire SQL type is inferred from the
value so the parameter binds correctly in any context, including `LIMIT`
and `OFFSET`:

- JS integer in `[-2^31, 2^31 - 1]` → `INT`
- JS integer outside `INT` but within `Number.MAX_SAFE_INTEGER` → `BIGINT`
- JS non-integer (`3.14`) → `DOUBLE`
- integer-shaped string in `INT` range → `INT` (common HTTP-input case)
- integer-shaped string outside `INT` but within `BIGINT` → `BIGINT`
- decimal-shaped string (`"123.45"`) → `NUMERIC` (preserves precision)

Why default to `INT`? Spark's `LIMIT` and `OFFSET` operators require
`IntegerType` specifically — `BIGINT` (`LongType`) is rejected with
`INVALID_LIMIT_LIKE_EXPRESSION.DATA_TYPE`. Catalyst auto-widens `INT`
to `BIGINT` / `DECIMAL` / `DOUBLE` for wider columns, so `INT` is a
strictly better default than `BIGINT`.

Throws on `NaN`, `Infinity`, JS integers outside `Number.MAX_SAFE_INTEGER`,
integer-shaped strings outside the `BIGINT` range, or non-numeric strings.
Reach for `sql.int()`, `sql.bigint()`, `sql.float()`, `sql.double()`, or
`sql.numeric()` to override the inferred type.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` | Number or numeric string |

#### Returns

`SQLNumberMarker`

Marker for a numeric SQL parameter

#### Example

```typescript
sql.number(123);              // { __sql_type: "INT",    value: "123" }
sql.number(3_000_000_000);    // { __sql_type: "BIGINT", value: "3000000000" }
sql.number(0.5);              // { __sql_type: "DOUBLE", value: "0.5" }
sql.number("10");             // { __sql_type: "INT",    value: "10" }
sql.number("123.45");         // { __sql_type: "NUMERIC", value: "123.45" }
```

### numeric()

```ts
numeric(value: string | number): SQLNumberMarker & {
  __sql_type: "NUMERIC";
};
```

Creates a `NUMERIC` (fixed-point DECIMAL) parameter. Use when you need
exact decimal arithmetic (currency, percentages) — pass values as
strings to avoid JS-number precision loss.

Note: passing a JS `number` is accepted but lossy for many values
(e.g. `0.1 + 0.2` → `"0.30000000000000004"`). Prefer strings.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` \| `number` | Number or numeric string (strings preferred for precision) |

#### Returns

`SQLNumberMarker` & \{
  `__sql_type`: `"NUMERIC"`;
\}

Marker pinned to `NUMERIC`

#### Example

```typescript
sql.numeric("12345.6789");   // { __sql_type: "NUMERIC", value: "12345.6789" }
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
