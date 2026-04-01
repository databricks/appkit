# Using Protobuf with AppKit

Typed data contracts via protobuf codegen. Define data shapes in `.proto` files, generate TypeScript types with `buf`, use them with AppKit's files and lakebase plugins.

Not a plugin — a codegen pattern using `@bufbuild/protobuf` or `ts-proto` directly.

## When to use

- Multiple plugins exchanging data (files + lakebase + jobs)
- Backend jobs produce data that server/frontend consumes
- Python and TypeScript services share data structures
- You want compile-time guarantees on cross-boundary data

## Setup

```bash
pnpm add @bufbuild/protobuf
pnpm add -D @bufbuild/buf @bufbuild/protoc-gen-es
```

```protobuf
// proto/myapp/v1/models.proto
syntax = "proto3";
package myapp.v1;

message Customer {
  string id = 1;
  string name = 2;
  string email = 3;
  double lifetime_value = 4;
  bool is_active = 5;
}
```

```bash
npx buf generate proto/
```

## With Files plugin

```ts
import { toJson, fromJson } from "@bufbuild/protobuf";
import { CustomerSchema } from "../proto/gen/myapp/v1/models_pb.js";

// Write
const json = toJson(CustomerSchema, customer);
await app.files("data").upload("customers/cust-001.json", Buffer.from(JSON.stringify(json)));

// Read
const data = await app.files("data").read("customers/cust-001.json");
const loaded = fromJson(CustomerSchema, JSON.parse(data.toString()));
```

## With Lakebase plugin

```ts
const json = toJson(CustomerSchema, customer);
await app.lakebase.query(
  `INSERT INTO customers (id, name, email, lifetime_value, is_active) VALUES ($1, $2, $3, $4, $5)`,
  [json.id, json.name, json.email, json.lifetimeValue, json.isActive],
);

const { rows } = await app.lakebase.query("SELECT * FROM customers WHERE id = $1", [id]);
const customer = fromJson(CustomerSchema, rows[0]);
```

## In API routes

```ts
import { fromJson, toJson } from "@bufbuild/protobuf";

expressApp.post("/api/orders", express.json(), (req, res) => {
  const order = fromJson(OrderSchema, req.body); // validates shape
  res.json(toJson(OrderSchema, order));           // guarantees output
});
```

## Proto → Lakebase DDL

| Proto type | SQL type | Default |
|-----------|----------|---------|
| `string` | `TEXT` | `''` |
| `bool` | `BOOLEAN` | `false` |
| `int32`/`int64` | `INTEGER`/`BIGINT` | `0` |
| `double` | `DOUBLE PRECISION` | `0.0` |
| `Timestamp` | `TIMESTAMPTZ` | `NOW()` |
| `repeated T` / `map<K,V>` | `JSONB` | `'[]'` / `'{}'` |

## Buf config

```yaml
# proto/buf.yaml
version: v2
lint:
  use: [STANDARD]

# proto/buf.gen.yaml
version: v2
plugins:
  - local: protoc-gen-es
    out: proto/gen
    opt: [target=ts]
```

Alternative: [ts-proto](https://github.com/stephenh/ts-proto) if you prefer its codegen style.
